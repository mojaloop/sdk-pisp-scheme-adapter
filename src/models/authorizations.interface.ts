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
import { PostAuthorizationsRequest, ThirdpartyRequests } from '@mojaloop/sdk-standard-components'
import { PubSub } from '~/shared/pub-sub'

export enum AuthenticationType {
  OTP = 'OTP',
  QRCODE = 'QRCODE',
  U2F = 'U2F'
}

export interface AuthenticationValue {
  pinValue: string
  counter: string
}

export interface AuthenticationInfo {
  authentication: AuthenticationType
  authenticationValue: AuthenticationValue | string
}

export enum AuthorizationResponse {
  ENTERED = 'ENTERED',
  REJECTED = 'REJECTED',
  RESEND = 'RESEND'
}

export enum OutboundAuthorizationsModelState {
  start = 'WAITING_FOR_AUTHORIZATION_REQUEST',
  succeeded = 'COMPLETED',
  errored = 'ERROR_OCCURRED'
}

export interface InboundAuthorizationsPutRequest {
  authenticationInfo: AuthenticationInfo;
  responseType: AuthorizationResponse;
}
export interface InboundAuthorizationsPostRequest {
  authenticationType: string
  retriesLeft: string
  amount: {
    currency: string
    amount: string
  },
  transactionId: string
  transactionRequestId: string
  quote: {
    transferAmount: {
      currency: string
      amount: string
    },
    expiration: string
    ilpPacket: string
    condition: string
  }
}

export interface OutboundAuthorizationsPostResponse extends InboundAuthorizationsPutRequest {
  currentState: OutboundAuthorizationsModelState;
}

export interface OutboundAuthorizationStateMachine extends ControlledStateMachine {
  requestAuthorization: Method
  onRequestAuthorization: Method
}

export interface OutboundAuthorizationsModelConfig extends PersistentModelConfig {
  pubSub: PubSub
  requests: ThirdpartyRequests
}

export interface OutboundAuthorizationData extends StateData {
  toParticipantId: string
  request: PostAuthorizationsRequest
  response?: OutboundAuthorizationsPostResponse
}

export interface OutboundAuthorizationsPostRequest extends InboundAuthorizationsPostRequest {
  toParticipantId: string
}
