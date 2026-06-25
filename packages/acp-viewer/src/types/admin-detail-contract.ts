import type {
  AdminAgentDetailResponse,
  AdminProjectDetailResponse,
} from '../../../acp-server/src/handlers/admin-detail-response-types'

import type { AgentDetailResponse, ProjectDetailResponse } from './api'

type AssertTrue<T extends true> = T
type IsAssignable<Source, Target> = Source extends Target ? true : false

export type AdminDetailWireContract = [
  AssertTrue<IsAssignable<AdminProjectDetailResponse, ProjectDetailResponse>>,
  AssertTrue<IsAssignable<AdminAgentDetailResponse, AgentDetailResponse>>,
]
