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

 - Paweł Marzec <pawel.marzec@modusbox.com>
 --------------
 ******/
import { KVS } from '~/shared/kvs'
import {
  Message,
  NotificationCallback,
  PubSub
} from '~/shared/pub-sub'
import { MojaloopRequests, TAmountType, ThirdpartyRequests, TParty } from '@mojaloop/sdk-standard-components'
import {
  PISPTransactionData,
  PISPTransactionModelConfig,
  // PISPTransactionModelState,
  PISPTransactionPhase,
  ThirdpartyTransactionApproveResponse,
  ThirdpartyTransactionInitiateResponse,
  ThirdpartyTransactionPartyLookupResponse,
  ThirdpartyTransactionStatus
  // PISPTransactionStateMachine,
  // ThirdpartyTransactionApproveResponse,
  // ThirdpartyTransactionInitiateResponse,
  // ThirdpartyTransactionPartyLookupResponse,
  // ThirdpartyTransactionStatus
} from '~/models/pispTransaction.interface'
import {
  PISPTransactionModel,
  create,
  loadFromKVS
} from '~/models/pispTransaction.model'
import { RedisConnectionConfig } from '~/shared/redis-connection'
import { mocked } from 'ts-jest/utils'

import mockLogger from 'test/unit/mockLogger'
import shouldNotBeExecuted from 'test/unit/shouldNotBeExecuted'
import sortedArray from 'test/unit/sortedArray'
import { AuthenticationType, AuthorizationResponse, InboundAuthorizationsPostRequest, InboundAuthorizationsPutRequest } from '~/models/authorizations.interface'

// mock KVS default exported class
jest.mock('~/shared/kvs')

// mock PubSub default exported class
jest.mock('~/shared/pub-sub')

describe('pipsTransactionModel', () => {
  const connectionConfig: RedisConnectionConfig = {
    port: 6789,
    host: 'localhost',
    logger: mockLogger()
  }
  let modelConfig: PISPTransactionModelConfig

  beforeEach(async () => {
    let subId = 0
    let handler: NotificationCallback

    modelConfig = {
      key: 'cache-key',
      kvs: new KVS(connectionConfig),
      pubSub: new PubSub(connectionConfig),
      logger: connectionConfig.logger,
      thirdpartyRequests: {
        postThirdpartyRequestsTransactions: jest.fn(() => Promise.resolve({ statusCode: 202 }))
      } as unknown as ThirdpartyRequests,
      mojaloopRequests: {
        getParties: jest.fn(() => Promise.resolve({ statusCode: 202 })),
        putAuthorizations: jest.fn(() => Promise.resolve({ statusCode: 202 }))
      } as unknown as MojaloopRequests
    }
    mocked(modelConfig.pubSub.subscribe).mockImplementationOnce(
      (_channel: string, cb: NotificationCallback) => {
        handler = cb
        return ++subId
      }
    )

    mocked(modelConfig.pubSub.publish).mockImplementationOnce(
      async (channel: string, message: Message) => handler(channel, message, subId)
    )

    await modelConfig.kvs.connect()
    await modelConfig.pubSub.connect()
  })

  afterEach(async () => {
    await modelConfig.kvs.disconnect()
    await modelConfig.pubSub.disconnect()
  })
  function checkPTMLayout (ptm: PISPTransactionModel, optData?: PISPTransactionData) {
    expect(ptm).toBeTruthy()
    expect(ptm.data).toBeDefined()
    expect(ptm.fsm.state).toEqual(optData?.currentState || 'start')

    // check new getters
    expect(ptm.pubSub).toEqual(modelConfig.pubSub)
    expect(ptm.mojaloopRequests).toEqual(modelConfig.mojaloopRequests)
    expect(ptm.thirdpartyRequests).toEqual(modelConfig.thirdpartyRequests)

    // check is fsm correctly constructed
    expect(typeof ptm.fsm.init).toEqual('function')
    expect(typeof ptm.fsm.requestPartyLookup).toEqual('function')
    expect(typeof ptm.fsm.initiate).toEqual('function')
    expect(typeof ptm.fsm.approve).toEqual('function')

    // check fsm notification handler
    expect(typeof ptm.onRequestPartyLookup).toEqual('function')
    expect(typeof ptm.onInitiate).toEqual('function')
    expect(typeof ptm.onApprove).toEqual('function')

    expect(sortedArray(ptm.fsm.allStates())).toEqual([
      'authorizationReceived',
      'errored',
      'none',
      'partyLookupSuccess',
      'start',
      'transactionStatusReceived'
    ])
    expect(sortedArray(ptm.fsm.allTransitions())).toEqual([
      'approve',
      'error',
      'init',
      'initiate',
      'requestPartyLookup'
    ])
  }

  it('module layout', () => {
    expect(typeof PISPTransactionModel).toEqual('function')
    expect(typeof loadFromKVS).toEqual('function')
    expect(typeof create).toEqual('function')
  })

  describe('transaction flow', () => {
    const party: TParty = {
      partyIdInfo: {
        fspId: 'fsp-id',
        partyIdType: 'party-id-type',
        partyIdentifier: 'party-identifier'
      }
    }

    describe('Party Lookup Phase', () => {
      let lookupData: PISPTransactionData
      let channel: string

      beforeEach(async () => {
        lookupData = {
          transactionRequestId: '1234-1234',
          currentState: 'start',
          payeeRequest: {
            partyIdType: 'party-id-type',
            partyIdentifier: 'party-identifier'
          }
        }
        channel = PISPTransactionModel.partyNotificationChannel(
          PISPTransactionPhase.lookup, 'party-id-type', 'party-identifier'
        )
      })

      it('should be well constructed', async () => {
        const model = await create(lookupData, modelConfig)
        checkPTMLayout(model, lookupData)
        expect(channel).toEqual('pisp_transaction_lookup_party-id-type_party-identifier')
      })

      it('should give response properly populated from notification channel', async () => {
        const model = await create(lookupData, modelConfig)

        // defer publication to notification channel
        setImmediate(() => model.pubSub.publish(
          channel,
          party as unknown as Message
        ))
        // let be sure we don't have expected data yet
        expect(model.data.payeeResolved).toBeFalsy()
        expect(model.data.partyLookupResponse).toBeFalsy()

        // do a request and await on published Message
        await model.fsm.requestPartyLookup()

        // check that correct subscription has been done
        expect(modelConfig.pubSub.subscribe).toBeCalledWith(channel, expect.anything())

        // check that correct unsubscription has been done
        expect(modelConfig.pubSub.unsubscribe).toBeCalledWith(channel, 1)

        // check we got needed part of response stored
        expect(model.data.payeeResolved).toEqual(party)

        // check we got lookup response phase response stored
        expect(model.data.partyLookupResponse).toEqual({
          party,
          currentState: 'partyLookupSuccess'
        })

        // check we made a call to mojaloopRequest.getParties
        expect(modelConfig.mojaloopRequests.getParties).toBeCalledWith('party-id-type', 'party-identifier', undefined)
      })
    })

    describe('Initiate Transaction Phase', () => {
      let data: PISPTransactionData
      let channel: string

      const authorizationRequest: InboundAuthorizationsPostRequest = {
        transactionRequestId: '1234-1234',
        transactionId: '5678-5678',
        authenticationType: 'authentication-type',
        retriesLeft: '1',
        amount: {
          amount: '123.00',
          currency: 'USD'
        },
        quote: {
          transferAmount: {
            amount: '123.00',
            currency: 'USD'
          },
          expiration: 'quote-expiration',
          ilpPacket: 'quote-ilp-packet',
          condition: 'quote-condition'
        }
      }

      beforeEach(async () => {
        data = {
          transactionRequestId: '1234-1234',
          currentState: 'partyLookupSuccess',
          payeeRequest: {
            partyIdType: 'party-id-type',
            partyIdentifier: 'party-identifier'
          },
          payeeResolved: party,
          initiateRequest: {
            transactionRequestId: '1234-1234',
            sourceAccountId: 'source-account-id',
            consentId: 'consent-id',
            payee: party,
            payer: {
              partyIdInfo: {
                fspId: 'payer-fsp-id',
                partyIdType: 'payer-party-id-type',
                partyIdentifier: 'payer-party-identifier'
              }
            },
            amountType: 'SEND' as TAmountType,
            amount: {
              amount: '123.00',
              currency: 'USD'
            },
            transactionType: {
              scenario: 'transaction-type-scenario',
              initiator: 'transaction-type-initiator',
              initiatorType: 'transaction-type-initiator-type'
            },
            expiration: 'expiration'
          }
        }
        channel = PISPTransactionModel.notificationChannel(
          PISPTransactionPhase.initiation,
          '1234-1234'
        )
      })

      it('should be well constructed', async () => {
        const model = await create(data, modelConfig)
        checkPTMLayout(model, data)
        expect(channel).toEqual('pisp_transaction_initiation_1234-1234')
      })

      it('should give response properly populated from notification channel', async () => {
        const model = await create(data, modelConfig)
        // defer publication to notification channel
        setImmediate(() => model.pubSub.publish(
          channel,
          authorizationRequest as unknown as Message
        ))
        // let be sure we don't have expected data yet
        expect(model.data.authorizationRequest).toBeFalsy()
        expect(model.data.initiateResponse).toBeFalsy()

        // do a request and await on published Message
        await model.fsm.initiate()

        // check that correct subscription has been done
        expect(modelConfig.pubSub.subscribe).toBeCalledWith(channel, expect.anything())

        // check that correct unsubscription has been done
        expect(modelConfig.pubSub.unsubscribe).toBeCalledWith(channel, 1)

        // check we got needed part of response stored
        expect(model.data.authorizationRequest).toEqual(authorizationRequest)

        // check we got initiate response phase response stored
        expect(model.data.initiateResponse).toEqual({
          authorization: { ...authorizationRequest },
          currentState: 'authorizationReceived'
        })

        // check we made a call to mojaloopRequest.getParties
        expect(modelConfig.thirdpartyRequests.postThirdpartyRequestsTransactions).toBeCalledWith(
          data.initiateRequest,
          data.initiateRequest?.payer.partyIdInfo.fspId
        )
      })
    })

    describe('channel names', () => {
      test('notificationChannel', () => {
        const phases = [
          PISPTransactionPhase.lookup,
          PISPTransactionPhase.initiation,
          PISPTransactionPhase.approval
        ]

        phases.forEach((phase) => {
          expect(PISPTransactionModel.notificationChannel(phase, 'trx-id')).toEqual(`pisp_transaction_${phase}_trx-id`)
          expect(() => PISPTransactionModel.notificationChannel(phase, '')).toThrowError('PISPTransactionModel.notificationChannel: \'transactionRequestId\' parameter is required')
          expect(() => PISPTransactionModel.notificationChannel(phase, null as unknown as string)).toThrowError('PISPTransactionModel.notificationChannel: \'transactionRequestId\' parameter is required')
        })
      })

      test('partyNotificationChannel', () => {
        const phases = [
          PISPTransactionPhase.lookup,
          PISPTransactionPhase.initiation,
          PISPTransactionPhase.approval
        ]

        phases.forEach((phase) => {
          // standard version
          expect(PISPTransactionModel.partyNotificationChannel(phase, 'party-type', 'party-id', 'party-sub-id'))
            .toEqual(`pisp_transaction_${phase}_party-type_party-id_party-sub-id`)
          // no subId
          expect(PISPTransactionModel.partyNotificationChannel(phase, 'party-type', 'party-id'))
            .toEqual(`pisp_transaction_${phase}_party-type_party-id`)
          // input validation party-type
          expect(() => PISPTransactionModel.partyNotificationChannel(phase, '', 'party-id', 'party-sub-id'))
            .toThrowError('PISPTransactionModel.partyNotificationChannel: \'partyType, id, subId (when specified)\' parameters are required')
          expect(() => PISPTransactionModel.partyNotificationChannel(phase, null as unknown as string, 'party-id', 'party-sub-id'))
            .toThrowError('PISPTransactionModel.partyNotificationChannel: \'partyType, id, subId (when specified)\' parameters are required')
          // input validation party-id
          expect(() => PISPTransactionModel.partyNotificationChannel(phase, 'party-type', '', 'party-sub-id'))
            .toThrowError('PISPTransactionModel.partyNotificationChannel: \'partyType, id, subId (when specified)\' parameters are required')
          expect(() => PISPTransactionModel.partyNotificationChannel(phase, 'party-type', null as unknown as string, 'party-sub-id'))
            .toThrowError('PISPTransactionModel.partyNotificationChannel: \'partyType, id, subId (when specified)\' parameters are required')
          // input validation party-sub-id
          expect(() => PISPTransactionModel.partyNotificationChannel(phase, 'party-type', 'party-id', ''))
            .toThrowError('PISPTransactionModel.partyNotificationChannel: \'partyType, id, subId (when specified)\' parameters are required')
        })
      })
    })

    describe('getResponse', () => {
      it('should give valid response', async () => {
        const data = {
          transactionRequestId: '1234-1234',
          currentState: 'start'
        }
        const model = await create(data, modelConfig)

        // void responses
        model.data.currentState = 'start'
        expect(model.getResponse()).toBeUndefined()

        model.data.currentState = 'errored'
        expect(model.getResponse()).toBeUndefined()

        model.data.currentState = 'partyLookupSuccess'
        model.data.partyLookupResponse = { am: 'party-lookup-mocked-response' } as unknown as ThirdpartyTransactionPartyLookupResponse
        expect(model.getResponse()).toEqual({ am: 'party-lookup-mocked-response' })

        model.data.currentState = 'authorizationReceived'
        model.data.initiateResponse = { am: 'authorization-received-mocked-response' } as unknown as ThirdpartyTransactionInitiateResponse
        expect(model.getResponse()).toEqual({ am: 'authorization-received-mocked-response' })

        model.data.currentState = 'transactionStatusReceived'
        model.data.approveResponse = { am: 'transaction-status-mocked-response' } as unknown as ThirdpartyTransactionApproveResponse
        expect(model.getResponse()).toEqual({ am: 'transaction-status-mocked-response' })
      })
    })

    describe('Approve Transaction Phase', () => {
      let data: PISPTransactionData
      let channel: string

      const authorizationResponse: InboundAuthorizationsPutRequest = {
        authenticationInfo: {
          authentication: AuthenticationType.U2F,
          authenticationValue: {
            pinValue: 'pin-value',
            counter: '1'
          }
        },
        responseType: AuthorizationResponse.ENTERED
      }

      const transactionStatus: ThirdpartyTransactionStatus = {
        transactionId: '5678-5678',
        transactionRequestState: 'ACCEPTED'
      }

      beforeEach(async () => {
        data = {
          transactionRequestId: '1234-1234',
          currentState: 'authorizationReceived',
          payeeRequest: {
            partyIdType: 'party-id-type',
            partyIdentifier: 'party-identifier'
          },
          payeeResolved: party,
          initiateRequest: {
            transactionRequestId: '1234-1234',
            sourceAccountId: 'source-account-id',
            consentId: 'consent-id',
            payee: party,
            payer: {
              partyIdInfo: {
                fspId: 'payer-fsp-id',
                partyIdType: 'payer-party-id-type',
                partyIdentifier: 'payer-party-identifier'
              }
            },
            amountType: 'SEND' as TAmountType,
            amount: {
              amount: '123.00',
              currency: 'USD'
            },
            transactionType: {
              scenario: 'transaction-type-scenario',
              initiator: 'transaction-type-initiator',
              initiatorType: 'transaction-type-initiator-type'
            },
            expiration: 'expiration'
          },
          approveRequest: {
            authorizationResponse,
            transactionRequestId: '1234-1234'
          }
        }
        channel = PISPTransactionModel.notificationChannel(
          PISPTransactionPhase.approval,
          '1234-1234'
        )
      })

      it('should be well constructed', async () => {
        const model = await create(data, modelConfig)
        checkPTMLayout(model, data)
        expect(channel).toEqual('pisp_transaction_approval_1234-1234')
      })

      it('should give response properly populated from notification channel', async () => {
        const model = await create(data, modelConfig)
        // defer publication to notification channel
        setImmediate(() => model.pubSub.publish(
          channel,
          transactionStatus as unknown as Message
        ))
        // let be sure we don't have expected data yet
        expect(model.data.transactionStatus).toBeFalsy()
        expect(model.data.approveResponse).toBeFalsy()

        // do a request and await on published Message
        await model.fsm.approve()

        // check that correct subscription has been done
        expect(modelConfig.pubSub.subscribe).toBeCalledWith(channel, expect.anything())

        // check that correct unsubscription has been done
        expect(modelConfig.pubSub.unsubscribe).toBeCalledWith(channel, 1)

        // check we got needed part of response stored
        expect(model.data.transactionStatus).toEqual(transactionStatus)

        // check we got initiate response phase response stored
        expect(model.data.approveResponse).toEqual({
          transactionStatus: { ...transactionStatus },
          currentState: 'transactionStatusReceived'
        })

        // check we made a call to mojaloopRequest.putAuthorizations
        expect(modelConfig.mojaloopRequests.putAuthorizations).toBeCalledWith(
          data.transactionRequestId,
          authorizationResponse,
          data.initiateRequest?.payer.partyIdInfo.fspId
        )
      })
    })
  })

  describe('loadFromKVS', () => {
    it('should properly call `KVS.get`, get expected data in `context.data` and setup state of machine', async () => {
      const dataFromCache: PISPTransactionData = {
        transactionRequestId: '1234-1234',
        currentState: 'transactionStatusReceived'
      }
      mocked(modelConfig.kvs.get).mockImplementationOnce(async () => dataFromCache)
      const model = await loadFromKVS(modelConfig)
      checkPTMLayout(model, dataFromCache)

      // to get value from cache proper key should be used
      expect(mocked(modelConfig.kvs.get)).toHaveBeenCalledWith(modelConfig.key)

      // check what has been stored in `data`
      expect(model.data).toEqual(dataFromCache)
    })

    it('should throw when received invalid data from `KVS.get`', async () => {
      mocked(modelConfig.kvs.get).mockImplementationOnce(async () => null)
      try {
        await loadFromKVS(modelConfig)
        shouldNotBeExecuted()
      } catch (error) {
        expect(error.message).toEqual(`No data found in KVS for: ${modelConfig.key}`)
      }
    })

    it('should propagate error received from `KVS.get`', async () => {
      mocked(modelConfig.kvs.get).mockImplementationOnce(jest.fn(async () => { throw new Error('error from KVS.get') }))
      expect(() => loadFromKVS(modelConfig))
        .rejects.toEqual(new Error('error from KVS.get'))
    })
  })

  describe('saveToKVS', () => {
    it('should store using KVS.set', async () => {
      mocked(modelConfig.kvs.set).mockImplementationOnce(() => Promise.resolve(true))
      const data: PISPTransactionData = {
        transactionRequestId: '1234-1234',
        currentState: 'transactionStatusReceived'
      }
      const model = await create(data, modelConfig)
      checkPTMLayout(model, data)

      // transition `init` should encounter exception when saving `context.data`
      await model.saveToKVS()
      expect(mocked(modelConfig.kvs.set)).toBeCalledWith(model.key, model.data)
    })
  })
  it('should propagate error from KVS.set', async () => {
    mocked(modelConfig.kvs.set).mockImplementationOnce(() => { throw new Error('error from KVS.set') })
    const data: PISPTransactionData = {
      transactionRequestId: '1234-1234',
      currentState: 'transactionStatusReceived'
    }
    const model = await create(data, modelConfig)
    checkPTMLayout(model, data)

    // transition `init` should encounter exception when saving `context.data`
    expect(() => model.saveToKVS()).rejects.toEqual(new Error('error from KVS.set'))
    expect(mocked(modelConfig.kvs.set)).toBeCalledWith(model.key, model.data)
  })
})
