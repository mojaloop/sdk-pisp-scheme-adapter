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

 --------------
 ******/
import { StateResponseToolkit } from '~/server/plugins/state'
import {
  PISPTransactionModelConfig,
  ThirdpartyTransactionInitiateRequest,
} from '~/models/pispTransaction.interface'
import {
  PISPTransactionModel,
  loadFromKVS
} from '~/models/pispTransaction.model'
import { Request, ResponseObject } from '@hapi/hapi'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post (_context: any, request: Request, h: StateResponseToolkit): Promise<ResponseObject> {
  const payload = request.payload as ThirdpartyTransactionInitiateRequest

  // prepare model config
  const modelConfig: PISPTransactionModelConfig = {
    kvs: h.getKVS(),
    pubSub: h.getPubSub(),
    key: payload.transactionRequestId,
    logger: h.getLogger(),
    thirdpartyRequests: h.getThirdpartyRequests(),
    mojaloopRequests: h.getMojaloopRequests(),
  }

  // load model
  const model: PISPTransactionModel = await loadFromKVS(modelConfig)
  model.data.initiateRequest = payload
  // probably this is not rquired, state machine should be already in partyLookupSuccess state
  //model.data.currentState = 'partyLookupSuccess'
  // run workflow and await on synchronous POST /authorizations response from Switch incoming on Inbound Service
  const result = await model.run()

  // there is a risk the workflow fail and in that case result is undefined
  if (!result) {
    h.getLogger().error('outbound POST /thirdpartyTransactions/initiate unexpected result from workflow')
    return h.response({}).code(500)
  }

  // send received response
  return h.response(result).code(200)
}

export default {
  post
}
