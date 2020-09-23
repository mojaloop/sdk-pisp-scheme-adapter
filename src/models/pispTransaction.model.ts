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

 - Sridhar Voruganti <sridhar.voruganti@modusbox.com>
 - Paweł Marzec <pawel.marzec@modusbox.com>
 --------------
 ******/
import { Message, PubSub } from '~/shared/pub-sub'
import { PersistentModel } from '~/models/persistent.model'
import { StateMachineConfig } from 'javascript-state-machine'
import { MojaloopRequests, PutAuthorizationRequest, ThirdpartyRequests, TParty } from '@mojaloop/sdk-standard-components'
import {
  PayeeLookupRequest,
  PISPTransactionData,
  PISPTransactionModelConfig,
  PISPTransactionModelState,
  PISPTransactionPhase,
  PISPTransactionStateMachine,
  ThirdpartyTransactionApproveResponse,
  ThirdpartyTransactionInitiateRequest,
  ThirdpartyTransactionInitiateResponse,
  ThirdpartyTransactionPartyLookupResponse,
  ThirdpartyTransactionStatus
} from './pispTransaction.interface'
import { InboundAuthorizationsPostRequest } from './authorizations.interface'
import inspect from '~/shared/inspect'

export class InvalidPISPTransactionDataError extends Error {
  public data: PISPTransactionData
  public propertyName: string
  constructor (data: PISPTransactionData, propertyName: string) {
    super(`invalid ${propertyName} data`)
    this.data = data
    this.propertyName = propertyName
  }

  static throwIfInvalidProperty (data: PISPTransactionData, propertyName: string): void {
    // eslint-disable-next-line no-prototype-builtins
    if (!data.hasOwnProperty(propertyName)) {
      throw new InvalidPISPTransactionDataError(data, propertyName)
    }
  }
}

export class PISPTransactionModel
  extends PersistentModel<PISPTransactionStateMachine, PISPTransactionData> {
  protected config: PISPTransactionModelConfig

  constructor (
    data: PISPTransactionData,
    config: PISPTransactionModelConfig
  ) {
    const spec: StateMachineConfig = {
      init: 'start',
      transitions: [
        // Party Lookup Phase
        { name: 'requestPartyLookup', from: 'start', to: 'partyLookupSuccess' },

        // Initiate Transaction Phase
        { name: 'initiate', from: 'partyLookupSuccess', to: 'authorizationReceived' },

        // Approve Transaction Phase
        { name: 'approve', from: 'authorizationReceived', to: 'transactionSuccess' }

      ],
      methods: {
        // specific transitions handlers methods
        onRequestPartyLookup: () => this.onRequestPartyLookup(),
        onInitiate: () => this.onInitiate(),
        onApprove: () => this.onApprove()
      }
    }
    super(data, config, spec)
    this.config = { ...config }
  }

  // getters
  get pubSub (): PubSub {
    return this.config.pubSub
  }

  get thirdpartyRequests (): ThirdpartyRequests {
    return this.config.thirdpartyRequests
  }

  get mojaloopRequests (): MojaloopRequests {
    return this.config.mojaloopRequests
  }

  // TODO: why can't we overload these?
  static notificationChannel (phase: PISPTransactionPhase, transactionRequestId: string): string {
    if (!transactionRequestId) {
      throw new Error('PISPTransactionModel.notificationChannel: \'transactionRequestId\' parameter is required')
    }
    // channel name
    return `pisp_transaction_${phase}_${transactionRequestId}`
  }

  static partyNotificationChannel (phase: PISPTransactionPhase, partyType: string, id: string, subId?: string): string {
    if (!(partyType && id)) {
      throw new Error(
        'PISPTransactionModel.partyNotificationChannel: \'partyType, id, subId (when specified)\' parameters are required'
      )
    }
    // channel name
    // format is: `pisp_transaction_<phase>_<partyTypeOrTransactionId>[_<subId>]`
    return [
      PISPTransactionModel.notificationChannel(phase, partyType),
      id,
      subId
    ].filter(x => !!x).join('_')
  }

  async onRequestPartyLookup (): Promise<void> {
    InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'payeeRequest')

    const { partyIdType, partyIdentifier, partySubIdOrType } = this.data?.payeeRequest as PayeeLookupRequest
    const channel = PISPTransactionModel.partyNotificationChannel(
      PISPTransactionPhase.lookup, partyIdType, partyIdentifier, partySubIdOrType
    )
    const pubSub: PubSub = this.pubSub

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      let subId = 0
      try {
        // this handler will be executed when PUT parties/<type>/<id>/<subId> @ Inbound server
        subId = this.pubSub.subscribe(channel, async (channel: string, message: Message, sid: number) => {
          // first unsubscribe
          pubSub.unsubscribe(channel, sid)

          this.data.payeeResolved = { ...message as unknown as TParty }
          this.data.partyLookupResponse = {
            party: { ...this.data.payeeResolved },
            currentState: PISPTransactionModelState[
              this.data.currentState as keyof typeof PISPTransactionModelState
            ]
          }
          resolve()
          // state machine should be in partyLookupSuccess state
        })

        const res = await this.mojaloopRequests.getParties(
          partyIdType,
          partyIdentifier,
          partySubIdOrType
        )
        this.logger.push({ res }).info('MojaloopRequests.getParties request sent to peer')
      } catch (error) {
        this.logger.push(error).error('MojaloopRequests.getParties request error')
        pubSub.unsubscribe(channel, subId)
        reject(error)
      }
    })
  }

  async onInitiate (): Promise<void> {
    InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'payeeRequest')
    InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'initiateRequest')

    const channel = PISPTransactionModel.notificationChannel(
      PISPTransactionPhase.initiation,
      this.data.transactionRequestId as string
    )
    const pubSub: PubSub = this.pubSub

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      let subId = 0
      try {
        // this handler will be executed when POST /authorizations @ Inbound server
        subId = this.pubSub.subscribe(channel, async (channel: string, message: Message, sid: number) => {
          // first unsubscribe
          pubSub.unsubscribe(channel, sid)

          this.data.authorizationRequest = { ...message as unknown as InboundAuthorizationsPostRequest }
          this.data.initiateResponse = {
            authorization: { ...this.data.authorizationRequest },
            currentState: PISPTransactionModelState[
              this.data.currentState as keyof typeof PISPTransactionModelState
            ]
          }
          resolve()
          // state machine should be in authorizationReceived state
        })
        InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'initiateRequest')

        const res = await this.thirdpartyRequests.postThirdpartyRequestsTransactions(
          this.data.initiateRequest as ThirdpartyTransactionInitiateRequest,
          this.data.initiateRequest?.payer.partyIdInfo.fspId as string
        )
        this.logger.push({ res }).info('ThirdpartyRequests.postThirdpartyRequestsTransactions request sent to peer')
      } catch (error) {
        this.logger.push(error).error('ThirdpartyRequests.postThirdpartyRequestsTransactions request error')
        pubSub.unsubscribe(channel, subId)
        reject(error)
      }
    })
  }

  async onApprove (): Promise<void> {
    InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'payeeRequest')
    InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'initiateRequest')
    InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'approveRequest')

    const channel = PISPTransactionModel.notificationChannel(
      PISPTransactionPhase.approval,
      this.data?.approveRequest?.transactionRequestId as string
    )
    const pubSub: PubSub = this.pubSub

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      let subId = 0
      try {
        // this handler will be executed when PATCH /thirdpartyRequests/transactions/{ID} @ Inbound server
        subId = this.pubSub.subscribe(channel, async (channel: string, message: Message, sid: number) => {
          // first unsubscribe
          pubSub.unsubscribe(channel, sid)

          this.data.transactionStatus = { ...message as unknown as ThirdpartyTransactionStatus }
          this.data.approveResponse = {
            transactionStatus: { ...this.data.transactionStatus },
            currentState: PISPTransactionModelState[
              this.data.currentState as keyof typeof PISPTransactionModelState
            ]
          }
          resolve()
          // state machine should be in transactionSuccess state
        })
        InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'payeeRequest')
        InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'initiateRequest')
        InvalidPISPTransactionDataError.throwIfInvalidProperty(this.data, 'approveRequest')

        const res = await this.mojaloopRequests.putAuthorizations(
          this.data.transactionRequestId!,
          // propagate signed challenge
          this.data?.approveRequest?.authorizationResponse as PutAuthorizationRequest,
          this.data?.initiateRequest?.payer.partyIdInfo.fspId as string
        )
        this.logger.push({ res }).info('ThirdpartyRequests.postThirdpartyRequestsTransactions request sent to peer')
      } catch (error) {
        this.logger.push(error).error('ThirdpartyRequests.postThirdpartyRequestsTransactions request error')
        pubSub.unsubscribe(channel, subId)
        reject(error)
      }
    })
  }

  /**
   * runs the workflow
   */
  async run (): Promise<
  ThirdpartyTransactionPartyLookupResponse |
  ThirdpartyTransactionInitiateResponse |
  ThirdpartyTransactionApproveResponse |
  void
  > {
    const data = this.data
    try {
      // run transitions based on incoming state
      switch (data.currentState) {
        // lookup phase
        case 'start':
          this.logger.info(
            `requestPartyLookup requested for ${data.transactionRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.requestPartyLookup()
          this.logger.info('requestPartyLookup completed successfully')
          await this.saveToKVS()
          return this.data.partyLookupResponse

        // initiate phase
        case 'partyLookupSuccess':
          this.logger.info(
            `initiate requested for ${data.transactionRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.initiate()
          this.logger.info('initiate completed successfully')
          await this.saveToKVS()
          return this.data.initiateResponse

        // approve phase
        case 'authorizationReceived':
          this.logger.info(
            `approve requested for ${data.transactionRequestId},  currentState: ${data.currentState}`
          )
          await this.fsm.approve()
          this.logger.info('approve completed successfully')
          await this.saveToKVS()
          return this.data.approveResponse

        case 'errored':
          // stopped in errored state
          this.logger.info('State machine in errored state')
          return
      }
    } catch (err) {
      this.logger.info(`Error running PISPTransactionModel : ${inspect(err)}`)

      // as this function is recursive, we don't want to error the state machine multiple times
      if (data.currentState !== 'errored') {
        // err should not have a pispTransactionState property here!
        if (err.pispTransactionState) {
          this.logger.info('State machine is broken')
        }
        // transition to errored state
        await this.fsm.error(err)

        // avoid circular ref between pispTransactionState.lastError and err
        // TODO: what to return incase of error
        err.pispTransactionState = { ...this.data.payeeRequest }
      }
      throw err
    }
  }
}

export async function create (
  data: PISPTransactionData,
  config: PISPTransactionModelConfig
): Promise<PISPTransactionModel> {
  // create a new model
  const model = new PISPTransactionModel(data, config)

  // enforce to finish any transition to state specified by data.currentState or spec.init
  await model.fsm.state
  return model
}

// loads PersistentModel from KVS storage using given `config` and `spec`
export async function loadFromKVS (
  config: PISPTransactionModelConfig
): Promise<PISPTransactionModel> {
  try {
    const data = await config.kvs.get<PISPTransactionData>(config.key)
    if (!data) {
      throw new Error(`No data found in KVS for: ${config.key}`)
    }
    config.logger.push({ data })
    config.logger.info('data loaded from KVS')
    return create(data, config)
  } catch (err) {
    config.logger.push({ err })
    config.logger.info(`Error loading data from KVS for key: ${config.key}`)
    throw err
  }
}
