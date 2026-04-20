export { main } from './cli.js'
export { normalizeScopeInput } from './scope-input.js'
export {
  DEFAULT_ACP_SERVER_URL,
  AcpClientHttpError,
  AcpClientTransportError,
  createHttpClient,
} from './http-client.js'
export type {
  AcpClient,
  AcpErrorBody,
  FetchLike,
  GetTaskResponse,
  ListTaskTransitionsResponse,
  TaskPromoteResponse,
  TaskContext,
  TaskTransitionResponse,
} from './http-client.js'
