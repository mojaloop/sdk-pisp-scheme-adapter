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
 - Paweł Marzec <pawel.marzec@modusbox.com>
 --------------
 ******/

import { BackendRequests } from './backend-requests'
import {
  Logger as SDKLogger,
  MojaloopRequests,
  Errors
} from '@mojaloop/sdk-standard-components'
import {
  v1_1 as fspiopAPI,
  thirdparty as tpAPI
} from '@mojaloop/api-snippets'
import { HTTPResponseError } from '~/shared/http-response-error'

export interface InboundAuthorizationsModelConfig {
  logger: SDKLogger.Logger
  backendRequests: BackendRequests
  mojaloopRequests: MojaloopRequests
}

export class InboundAuthorizationsModel {
  protected config: InboundAuthorizationsModelConfig

  constructor (config: InboundAuthorizationsModelConfig) {
    this.config = config
  }

  protected get logger (): SDKLogger.Logger {
    return this.config.logger
  }

  protected get backendRequests (): BackendRequests {
    return this.config.backendRequests
  }

  protected get mojaloopRequests (): MojaloopRequests {
    return this.config.mojaloopRequests
  }

  async postAuthorizations (
    inRequest: tpAPI.Schemas.AuthorizationsPostRequest,
    srcDfspId: string
  ): Promise<void> {
    try {
      const authenticationValue = await this.backendRequests.signAuthorizationRequest(inRequest)
      if (!authenticationValue) {
        throw new Error('no-authentication-value')
      }
      const authorizationPutPayload: fspiopAPI.Schemas.AuthorizationsIDPutResponse = {
        authenticationInfo: {
          authentication: 'U2F',
          authenticationValue
        },
        responseType: 'ENTERED'
      }
      await this.mojaloopRequests.putAuthorizations(
        inRequest.transactionRequestId,
        authorizationPutPayload,
        srcDfspId
      )
    } catch (err) {
      this.logger.push({ err }).error('Error in postAuthorization @ Inbound')
      const mojaloopError = this.reformatError(err)
      this.logger.push({ mojaloopError }).info(`Sending error response to ${srcDfspId}`)
      await this.mojaloopRequests.putAuthorizationsError(
        inRequest.transactionRequestId,
        mojaloopError as unknown as fspiopAPI.Schemas.ErrorInformationObject,
        srcDfspId
      )
    }
  }

  protected reformatError (err: Error): Errors.MojaloopApiErrorObject {
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
