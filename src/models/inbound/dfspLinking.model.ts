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
import { ThirdpartyRequests, Errors } from '@mojaloop/sdk-standard-components';
import {
  v1_1 as fspiopAPI,
  thirdparty as tpAPI
} from '@mojaloop/api-snippets'
import inspect from '~/shared/inspect'
import { reformatError, mkMojaloopFSPIOPError } from '~/shared/util'
import {
  DFSPLinkingData,
  DFSPLinkingStateMachine,
  DFSPLinkingModelConfig
} from '~/models/inbound/dfspLinking.interface'
import { DFSPBackendRequests } from '~/shared/dfsp-backend-requests'
import { BackendValidateOTPResponse } from './dfspLinking.interface';
import { HTTPResponseError } from '../../shared/http-response-error';
import { uuid } from 'uuidv4';

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
        { name: 'grantConsent', from: 'authTokenValidated', to: 'consentGranted' }
      ],
      methods: {
        // specific transitions handlers methods
        onValidateRequest: () => this.onValidateRequest(),
        onStoreReqAndSendOTP: () => this.onStoreReqAndSendOTP(),
        onValidateAuthToken: () => this.onValidateAuthToken(),
        onGrantConsent: () => this.onGrantConsent()
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

  async onValidateRequest (): Promise<void> {
    const { consentRequestsPostRequest, toParticipantId } = this.data

    // store consentRequestId since this will be referenced often
    this.data.consentRequestId = consentRequestsPostRequest.consentRequestId

    try {
      const response = await this.dfspBackendRequests.validateConsentRequests(consentRequestsPostRequest)

      if (!response) {
        throw mkMojaloopFSPIOPError(Errors.MojaloopApiErrorCodes.TP_CONSENT_REQ_VALIDATION_ERROR)
      }

      if (!response.isValid) {
        throw mkMojaloopFSPIOPError(Errors.MojaloopApiErrorCodeFromCode(`${response.errorInformation?.errorCode}`))
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
      const mojaloopError = await reformatError(error)

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
        throw new Errors.MojaloopFSPIOPError(
          null as unknown as string,
          null as unknown as string,
          null as unknown as string,
          Errors.MojaloopApiErrorCodes.TP_FSP_OTP_VALIDATION_ERROR
        )
      }

      if (!isValidOTP.isValid) {
        throw new Errors.MojaloopFSPIOPError(
          null as unknown as string,
          null as unknown as string,
          null as unknown as string,
          Errors.MojaloopApiErrorCodes.TP_OTP_VALIDATION_ERROR
        )
      }
    } catch (error) {
      const mojaloopError = this.reformatError(error)

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

    const postConsentRequestsPayload: tpAPI.Schemas.ConsentsPostRequest = {
      consentId: uuid(),
      consentRequestId: consentRequestId!,
      scopes: scopes || []
    }

    try {
      await this.thirdpartyRequests.postConsents(
        postConsentRequestsPayload,
        toParticipantId
      )
    } catch (error) {
      const mojaloopError = this.reformatError(error)

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

        default:
          this.logger.info('State machine in errored state')
          return
      }
    } catch (err) {
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

  reformatError (err: Error): Errors.MojaloopApiErrorObject {
    if (err instanceof Errors.MojaloopFSPIOPError) {
      return err.toApiErrorObject()
    }

    let mojaloopErrorCode = Errors.MojaloopApiErrorCodes.INTERNAL_SERVER_ERROR

    if (err instanceof HTTPResponseError) {
      const e = err.getData()
      if (e.res && (e.res.body || e.res.data)) {
        if (e.res.body) {
          try {
            const bodyObj = JSON.parse(e.res.body)
            mojaloopErrorCode = Errors.MojaloopApiErrorCodeFromCode(`${bodyObj.statusCode}`)
          } catch (ex) {
            // do nothing
            this.logger.push({ ex }).error('Error parsing error message body as JSON')
          }
        } else if (e.res.data) {
          mojaloopErrorCode = Errors.MojaloopApiErrorCodeFromCode(`${e.res.data.statusCode}`)
        }
      }
    }

    return new Errors.MojaloopFSPIOPError(
      err,
      null as unknown as string,
      null as unknown as string,
      mojaloopErrorCode
    ).toApiErrorObject()
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
