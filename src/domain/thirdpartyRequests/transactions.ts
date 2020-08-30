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

 - Kevin Leyow <kevin.leyow@modusbox.com>

 --------------
 ******/
import { ThirdpartyTransactionRequest, QuoteRequest } from '../../interface/types'
import { uuid } from 'uuidv4'
import { MojaloopRequests } from '@mojaloop/sdk-standard-components'
import config from '~/shared/config'
import Logger from '@mojaloop/central-services-logger'

export function buildPayeeQuoteRequestFromTptRequest (request: ThirdpartyTransactionRequest): QuoteRequest {
  const quoteRequest = {
    quoteId: uuid(),
    transactionId: uuid(),
    note: '',
    transactionRequestId: request.transactionRequestId,
    payee: request.payee,
    payer: request.payer,
    amountType: request.amountType,
    amount: request.amount,
    transactionType: request.transactionType
  }

  return quoteRequest
}

export async function forwardPostQuoteRequestToPayee (request: ThirdpartyTransactionRequest): Promise<void> {
  const quote = buildPayeeQuoteRequestFromTptRequest(request)

  const mojaloopRequests = new MojaloopRequests({
    logger: Logger,
    peerEndpoint: config.SHARED.PEER_ENDPOINT,
    alsEndpoint: config.SHARED.ALS_ENDPOINT,
    quotesEndpoint: config.SHARED.QUOTES_ENDPOINT,
    transfersEndpoint: config.SHARED.TRANSFERS_ENDPOINT,
    bulkTransfersEndpoint: config.SHARED.BULK_TRANSFERS_ENDPOINT,
    dfspId: config.SHARED.DFSP_ID,
    tls: config.SHARED.TLS,
    jwsSign: config.SHARED.JWS_SIGN,
    jwsSigningKey: <Buffer> config.SHARED.JWS_SIGNING_KEY
  })

  // payee fspid should be defined due to a prior GET /parties call.
  mojaloopRequests.postQuotes(quote, <string> quote.payee.partyIdInfo.fspId)
}

// todo: create dfsp outbound calls for these checks.
export async function verifyConsentId (_consentId: string): Promise<boolean> {
  return true
}

export async function verifySourceAccountId (_sourceAccountId: string): Promise<boolean> {
  return true
}

export async function verifyPispId (_pispId: string): Promise<boolean> {
  return true
}

export async function validateGrantedConsent (_consentId: string): Promise<boolean> {
  return true
}
