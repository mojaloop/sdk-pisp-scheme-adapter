/*****
 License
 --------------
 Copyright © 2020 Mojaloop Foundation
 The Mojaloop files are made available by the Mojaloop Foundation under the Apache License, Version 2.0 (the "License")
 and you may not use these files except in compliance with the License. You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed
 on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and limitations under the License.
 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.
 * Gates Foundation
 - Name Surname <name.surname@gatesfoundation.com>

 - Sridhar Voruganti - sridhar.voruganti@modusbox.com
 --------------
 ******/

import { PubSub } from '~/shared/pub-sub'
import { PersistentModel } from '~/models/persistent.model'
import { StateMachineConfig } from 'javascript-state-machine'
import { ThirdpartyRequests, Errors, MojaloopRequests } from '@mojaloop/sdk-standard-components';
import {
  v1_1 as fspiopAPI,
  thirdparty as tpAPI
} from '@mojaloop/api-snippets'
import inspect from '~/shared/inspect'
import {
  DFSPLinkingData,
  DFSPLinkingStateMachine,
  DFSPLinkingModelConfig
} from '~/models/inbound/dfspLinking.interface'
import { DFSPBackendRequests } from '~/shared/dfsp-backend-requests'
import { BackendValidateOTPResponse, DFSPLinkingPhase } from './dfspLinking.interface';
import { uuid } from 'uuidv4';
import { reformatError } from '~/shared/api-error';
import deferredJob from '../../shared/deferred-job';
import { Message } from '../../shared/pub-sub';

// DFSPLinkingModel is the passive inbound handler for inbound
// POST /consentRequests requests and no response is generated from `model.run()`
export class DFSPLinkingModel
  extends PersistentModel<DFSPLinkingStateMachine, DFSPLinkingData> {
  protected config: DFSPLinkingModelConfig

  constructor (
    data: DFSPLinkingData,
    config: DFSPLinkingModelConfig
  ) {
    const spec: StateMachineConfig = {
      init: 'start',
      transitions: [
        { name: 'validateRequest', from: 'start', to: 'requestIsValid' },
        { name: 'storeReqAndSendOTP', from: 'requestIsValid', to: 'consentRequestValidatedAndStored' },
        { name: 'validateAuthToken', from: 'consentRequestValidatedAndStored', to: 'authTokenValidated' },
        { name: 'grantConsent', from: 'authTokenValidated', to: 'consentGranted' },
        { name: 'validateWithAuthService', from: 'consentGranted', to: 'consentRegisteredAndValidated' },
        { name: 'finalizeThirdpartyLinkWithALS', from: 'consentRegisteredAndValidated', to: 'PISPDFSPLinkEstablished' },
        { name: 'notifyVerificationToPISP', from: 'PISPDFSPLinkEstablished', to: 'notificationSent' },
      ],
      methods: {
        // specific transitions handlers methods
        onValidateRequest: () => this.onValidateRequest(),
        onStoreReqAndSendOTP: () => this.onStoreReqAndSendOTP(),
        onValidateAuthToken: () => this.onValidateAuthToken(),
        onGrantConsent: () => this.onGrantConsent(),
        onValidateWithAuthService: () => this.onValidateWithAuthService(),
        onFinalizeThirdpartyLinkWithALS: () => this.onFinalizeThirdpartyLinkWithALS(),
        onNotifyVerificationToPISP: () => this.onNotifyVerificationToPISP()
      }
    }
    super(data, config, spec)
    this.config = { ...config }
  }

  // getters
  get pubSub (): PubSub {
    return this.config.pubSub
  }

  get dfspBackendRequests (): DFSPBackendRequests {
    return this.config.dfspBackendRequests
  }

  get thirdpartyRequests (): ThirdpartyRequests {
    return this.config.thirdpartyRequests
  }

  get mojaloopRequests (): MojaloopRequests {
    return this.config.mojaloopRequests
  }

  static notificationChannel (phase: DFSPLinkingPhase, id: string): string {
    if (!id) {
      throw new Error('DFSPLinkingModel.notificationChannel: \'id\' parameter is required')
    }
    // channel name
    return `DFSPLinking_${phase}_${id}`
  }

  static async triggerWorkflow (
    phase: DFSPLinkingPhase,
    id: string,
    pubSub: PubSub,
    message: Message
  ): Promise<void> {
    const channel = DFSPLinkingModel.notificationChannel(phase, id)
    return deferredJob(pubSub, channel).trigger(message)
  }

  // utility function to check if an error after a transistion which
  // pub/subs for a response that can return a mojaloop error
  async checkModelDataForErrorInformation (): Promise<void> {
    if (this.data.errorInformation) {
      await this.fsm.error(this.data.errorInformation)
    }
  }

  async onValidateRequest (): Promise<void> {
    const { consentRequestsPostRequest, toParticipantId } = this.data

    try {
      const response = await this.dfspBackendRequests.validateConsentRequests(consentRequestsPostRequest)

      if (!response) {
        throw Errors.MojaloopApiErrorCodes.TP_CONSENT_REQ_VALIDATION_ERROR
      }

      if (!response.isValid) {
        throw Errors.MojaloopApiErrorCodeFromCode(`${response.errorInformation?.errorCode}`)
      }

      this.data.backendValidateConsentRequestsResponse = response

      type consentRequestResponseType = tpAPI.Schemas.ConsentRequestsIDPutResponseOTP &
        tpAPI.Schemas.ConsentRequestsIDPutResponseWeb

      const consentRequestResponse = {
        consentRequestId: consentRequestsPostRequest.consentRequestId,
        scopes: consentRequestsPostRequest.scopes,
        callbackUri: consentRequestsPostRequest.callbackUri,
        authChannels: response.data.authChannels,
        authUri: response.data.authUri,
      } as consentRequestResponseType

      await this.thirdpartyRequests.putConsentRequests(consentRequestsPostRequest.consentRequestId, consentRequestResponse, toParticipantId)

    } catch (error) {
      const mojaloopError = reformatError(error, this.logger)

      this.logger.push({ error }).error('start -> requestIsValid')
      this.logger.push({ mojaloopError }).info(`Sending error response to ${toParticipantId}`)

      await this.thirdpartyRequests.putConsentRequestsError(
        consentRequestsPostRequest.consentRequestId,
        mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
        toParticipantId
      )

      // throw error to stop state machine
      throw error
    }
  }

  async onStoreReqAndSendOTP (): Promise<void> {
    const { consentRequestsPostRequest, backendValidateConsentRequestsResponse } = this.data

    // store scopes in model for future requests
    this.data.scopes = consentRequestsPostRequest.scopes

    try {
      const channel = [...backendValidateConsentRequestsResponse!.data.authChannels].pop()
      switch (channel) {
        case 'WEB': {
          await this.dfspBackendRequests.storeConsentRequests(consentRequestsPostRequest)
          break
        }
        case 'OTP': {
          await this.dfspBackendRequests.sendOTP(consentRequestsPostRequest)
          break
        }
        default: {
          this.logger.error(`Invalid authChannel ${channel}`)
          throw new Error(`Invalid authChannel ${channel}`)
        }
      }

    } catch (error) {
      this.logger.push({ error }).error('requestIsValid -> consentRequestValidatedAndStored')
      // TODO: PUT /consentRequest/{ID}/error if DFSP is unable to store consent Request or
      //       send OTP
      // throw error to stop state machine
      throw error
    }
  }

  async onValidateAuthToken (): Promise<void> {
    const { consentRequestId, consentRequestsIDPatchRequest, toParticipantId } = this.data

    try {
      const isValidOTP = await this.dfspBackendRequests.validateOTPSecret(
        consentRequestId!,
        consentRequestsIDPatchRequest!.authToken
      ) as BackendValidateOTPResponse

      if (!isValidOTP) {
        throw Errors.MojaloopApiErrorCodes.TP_FSP_OTP_VALIDATION_ERROR
      }

      if (!isValidOTP.isValid) {
        throw Errors.MojaloopApiErrorCodes.TP_OTP_VALIDATION_ERROR
      }

    } catch (error) {
      const mojaloopError = reformatError(error, this.logger)

      this.logger.push({ error }).error('consentRequestValidatedAndStored -> authTokenValidated')
      this.logger.push({ mojaloopError }).info(`Sending error response to ${toParticipantId}`)

      await this.thirdpartyRequests.putConsentRequestsError(
        consentRequestId!,
        mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
        toParticipantId
      )
      // throw error to stop state machine
      throw error
    }
  }


  async onGrantConsent (): Promise<void> {
    const { consentRequestId, toParticipantId, scopes } = this.data
    const consentId = uuid()

    // save consentId for later
    this.data.consentId = consentId

    const postConsentPayload: tpAPI.Schemas.ConsentsPostRequest = {
      consentId,
      consentRequestId: consentRequestId!,
      scopes: scopes || []
    }

    // save POST /consent request
    this.data.consentPostRequest = postConsentPayload

    try {
      await this.thirdpartyRequests.postConsents(
        postConsentPayload,
        toParticipantId
      )

      // We create a copy of the persistent model with `consentId` as the new
      // key. consentRequestId is no longer passed through requests after this
      // point so we need a soft copy of this model to retrieve the model
      // on later requests.
      const data: DFSPLinkingData = {
        ...this.data,
        currentState: 'consentGranted'
      }
      const consentIdModelConfig: DFSPLinkingModelConfig = {
        kvs: this.config.kvs,
        pubSub: this.config.pubSub,
        key: consentId,
        logger: this.config.logger,
        dfspBackendRequests: this.config.dfspBackendRequests,
        thirdpartyRequests: this.config.thirdpartyRequests,
        mojaloopRequests: this.config.mojaloopRequests,
        requestProcessingTimeoutSeconds: this.config.requestProcessingTimeoutSeconds
      }

      const model: DFSPLinkingModel = await create(data, consentIdModelConfig)
      await model.saveToKVS

    } catch (error) {
      const mojaloopError = reformatError(error, this.logger)

      this.logger.push({ error }).error('authTokenValidated -> consentGranted')
      this.logger.push(error).error('ThirdpartyRequests.postConsents request error')

      // note: if the POST /consents fails at the DFSP we report that back to the pisp
      await this.thirdpartyRequests.putConsentRequestsError(
        consentRequestId!,
        mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
        toParticipantId
      )
      // throw error to stop state machine
      throw error
    }
  }

  async onValidateWithAuthService (): Promise<void> {
    const { consentIDPutResponse, consentId } = this.data

    const consentPostRequestToAuthService: tpAPI.Schemas.ConsentsPostRequest = {
      consentId: consentId!,
      scopes: this.data.scopes!,
      credential: consentIDPutResponse!.credential
    }

    const waitOnAuthServiceResponse = DFSPLinkingModel.notificationChannel(
      DFSPLinkingPhase.waitOnAuthServiceResponse,
      consentId!
    )
    const waitOnALSParticipantResponse = DFSPLinkingModel.notificationChannel(
      DFSPLinkingPhase.waitOnALSParticipantResponse,
      consentId!
    )

    const waitOnAuthService = deferredJob(this.pubSub, waitOnAuthServiceResponse)
      .init(async (channel) => {
        const res = await this.thirdpartyRequests.postConsents(
          consentPostRequestToAuthService,
          this.data.toAuthServiceParticipantId
        )

        this.logger.push({ res, channel })
          .log('ThirdpartyRequests.postConsents call sent to auth service, listening on response')
      })
      .job(async (message: Message): Promise<void> => {
        try {
          type PutResponse =
            tpAPI.Schemas.ConsentsIDPutResponseVerified
          type PutResponseOrError = PutResponse & fspiopAPI.Schemas.ErrorInformationObject
          const putResponse = message as unknown as PutResponseOrError

          if (putResponse.errorInformation) {
            // if the auth-service sends back any error, inform PISP
            // that consent failed to validate with auth-service
            // todo: more detailed error handling depending on auth-service error response
            const mojaloopError = reformatError(
              Errors.MojaloopApiErrorCodes.TP_CONSENT_INVALID,
              this.logger
            )

            await this.thirdpartyRequests.putConsentsError(
              this.data.consentId!,
              mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
              this.data.toParticipantId
            )
            // store the error so we can transition to an errored state
            this.data.errorInformation = mojaloopError.errorInformation as unknown as fspiopAPI.Schemas.ErrorInformation
          } else {
            this.data.consentIDPutResponseFromAuthService = { ...message as unknown as PutResponse }
          }
        } catch (error) {
          this.logger.push(error).error('ThirdpartyRequests.postConsents request error')
          return Promise.reject(error)
        }
      })
      .wait(this.config.requestProcessingTimeoutSeconds * 1000)

    const waitOnALS = deferredJob(this.pubSub, waitOnALSParticipantResponse)
      .init(async (): Promise<void> => {
        return Promise.resolve()
      })
      .job(async (message: Message): Promise<void> => {
        type PutResponse =
          tpAPI.Schemas.ParticipantsTypeIDPutResponse
        type PutResponseOrError = PutResponse & fspiopAPI.Schemas.ErrorInformationObject
        const putResponse = message as unknown as PutResponseOrError

        if (putResponse.errorInformation) {
          // if the ALS sends back any error for now, notify the PISP that the account
          // linking process has failed
          // todo: more detailed error handling depending on auth-service error response
          const mojaloopError = reformatError(
            Errors.MojaloopApiErrorCodes.TP_ACCOUNT_LINKING_ERROR,
            this.logger
          )

          await this.thirdpartyRequests.putConsentsError(
            this.data.consentId!,
            mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
            this.data.toParticipantId
          )
          // store the error so we can transition to an errored state
          this.data.errorInformation = mojaloopError.errorInformation as unknown as fspiopAPI.Schemas.ErrorInformation
        } else {
          this.data.participantPutResponseFromALS = { ...message as unknown as fspiopAPI.Schemas.ParticipantsTypeIDPutResponse}
        }
      })
      .wait(this.config.requestProcessingTimeoutSeconds * 1000)

    // catch any unplanned errors and notify PISP
    try {
      await Promise.all([waitOnALS, waitOnAuthService])
    } catch (error) {
      // we send back an account linking error despite the actual error
      const mojaloopError = reformatError(
        Errors.MojaloopApiErrorCodes.TP_ACCOUNT_LINKING_ERROR,
        this.logger
      )

      // if the flow fails to run for any reason notify the PISP that the account
      // linking process has failed
      await this.thirdpartyRequests.putConsentsError(
        this.data.consentId!,
        mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
        this.data.toParticipantId
      )

      // throw the actual error
      throw error
    }
  }

  async onFinalizeThirdpartyLinkWithALS (): Promise<void> {
    // todo: send a bulk POST /participants request to ALS to
    //       store THIRD_PARTY_LINK entries

    /*
    const partyList: tpAPI.Schemas.PartyIdInfo[] = []
    for (const scope of this.data.scopes as tpAPI.Schemas.Scope[]) {
      var partyIdInfo: tpAPI.Schemas.PartyIdInfo = {
        partyIdType: 'THIRD_PARTY_LINK',
        partyIdentifier: scope.accountId
      }
      partyList.push(partyIdInfo)
    }

    const consentPostRequestToALSService: tpAPI.Schemas.ParticipantsPostRequest = {
      requestId: this.data.consentId!,
      partyList
    }

    const channel = DFSPLinkingModel.notificationChannel(
      DFSPLinkingPhase.waitOnThirdpartyLinkRegistrationResponse,
      this.data.consentId!
    )

    return deferredJob(this.pubSub, channel)
    .init(async (): Promise<void> => {
      // need to update `mojaloopRequests.postParticipants` to accept
      // 'THIRD_PARTY_LINK'
      const res = await this.mojaloopRequests.postParticipants(
        consentPostRequestToALSService,
        'auth-service'
      )
      this.logger.push({ res }).info('MojaloopRequests.postParticipants request sent to peer')
    })
    .job(async (message: Message): Promise<void> => {
    })
    .wait(this.config.requestProcessingTimeoutSeconds * 1000)

    // todo: if promise fails we need to send a PUT /consents/{ID}/error
    //       request back to the PISP
    */
  }

  async onNotifyVerificationToPISP (): Promise<void> {
    const { consentId } = this.data

    const consentPatchVerifiedRequest: tpAPI.Schemas.ConsentsIDPatchResponseVerified = {
      credential: {
        status: 'VERIFIED'
      }
    }
    // catch any unplanned errors
    try {
      await this.thirdpartyRequests.patchConsents(
        consentId!,
        consentPatchVerifiedRequest,
        this.data.toParticipantId
      )
    } catch (error) {
      // we send back an account linking error despite the actual error
      const mojaloopError = reformatError(
        Errors.MojaloopApiErrorCodes.TP_ACCOUNT_LINKING_ERROR,
        this.logger
      )
      // if the flow fails to run for any reason notify the PISP that the account
      // linking process has failed
      await this.thirdpartyRequests.putConsentsError(
        this.data.consentId!,
        mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
        this.data.toParticipantId
      )

      // throw actual error
      throw error
    }
  }

  /**
   * runs the workflow
   */
  async run (): Promise<void> {
    const data = this.data
    try {
      // run transitions based on incoming state
      switch (data.currentState) {
        case 'start':
          await this.saveToKVS()
          this.logger.info(
            `validateRequest requested for ${data.consentRequestsPostRequest.consentRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.validateRequest()
          await this.saveToKVS()
          return this.run();

        case 'requestIsValid':
          this.logger.info(
            `storeReqAndSendOTP requested for ${data.consentRequestsPostRequest.consentRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.storeReqAndSendOTP()
          await this.saveToKVS()
          // POST /consentRequest handled wait for PATCH /consentRequest{ID}
          return

        case 'consentRequestValidatedAndStored':
          this.logger.info(
            `validateAuthToken requested for ${data.consentRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.validateAuthToken()
          await this.saveToKVS()
          return this.run();

        case 'authTokenValidated':
          this.logger.info(
            `grantConsent requested for ${data.consentRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.grantConsent()
          await this.saveToKVS()
          // PATCH /consentRequest{ID} handled
          return

        case 'consentGranted':
          await this.fsm.validateWithAuthService()
          await this.checkModelDataForErrorInformation()
          this.logger.info(
            `validateWithAuthService requested for ${data.consentId},  currentState: ${data.currentState}`
          )
          await this.saveToKVS()
          return this.run()

        case 'consentRegisteredAndValidated':
          await this.fsm.finalizeThirdpartyLinkWithALS()
          await this.checkModelDataForErrorInformation()
          await this.saveToKVS()
          return this.run()

        case 'PISPDFSPLinkEstablished':
          await this.fsm.notifyVerificationToPISP()
          await this.checkModelDataForErrorInformation()
          await this.saveToKVS()
          return

        default:
          this.logger.info('State machine in errored state')
          return
      }
    } catch (err) {
      // TOOD: reformatError: https://github.com/mojaloop/thirdparty-scheme-adapter/blob/master/src/models/dfspTransaction.model.ts#L378
      this.logger.info(`Error running DFSPLinkingModel : ${inspect(err)}`)

      // as this function is recursive, we don't want to error the state machine multiple times
      if (data.currentState !== 'errored') {
        // err should not have a consentReqState property here!
        if (err.consentReqState) {
          this.logger.info('State machine is broken')
        }
        // transition to errored state
        await this.fsm.error(err)

        // avoid circular ref between consentReqState.lastError and err
        err.consentReqState = { ...this.data }
      }
      throw err
    }
  }
}

export async function existsInKVS (config: DFSPLinkingModelConfig): Promise<boolean> {
  return config.kvs.exists(config.key)
}

export async function create (
  data: DFSPLinkingData,
  config: DFSPLinkingModelConfig
): Promise<DFSPLinkingModel> {
  // create a new model
  const model = new DFSPLinkingModel(data, config)

  // enforce to finish any transition to state specified by data.currentState or spec.init
  await model.fsm.state
  return model
}

// loads PersistentModel from KVS storage using given `config` and `spec`
export async function loadFromKVS (
  config: DFSPLinkingModelConfig
): Promise<DFSPLinkingModel> {
  try {
    const data = await config.kvs.get<DFSPLinkingData>(config.key)
    if (!data) {
      throw new Error(`No data found in KVS for: ${config.key}`)
    }
    config.logger.push({ data }).info('data loaded from KVS')
    return create(data, config)
  } catch (err) {
    config.logger.push({ err }).info(`Error loading data from KVS for key: ${config.key}`)
    throw err
  }
}

export default {
  DFSPLinkingModel,
  existsInKVS,
  create,
  loadFromKVS
}
