export { GatewayDiscordApp, log, startGateway, type GatewayDiscordAppOptions } from './app.js'
export { BindingIndex, conversationKey, toConversationRefs } from './bindings.js'
export {
  DEFAULT_BINDINGS_REFRESH_MS,
  DEFAULT_DELIVERY_IDLE_MS,
  DEFAULT_DELIVERY_POLL_MS,
  DEFAULT_MAX_CHARS,
  envNumber,
  optionalEnv,
} from './config.js'
export { createDiscordAttachments, fetchMediaAttachments } from './attachments.js'
export { renderToDiscord } from './discord-render.js'
export { classifyDiscordError } from './discord-errors.js'
export {
  extractImagesFromFrame,
  extractMediaRefsFromFrame,
  renderActionsToCustomIds,
  renderFrameToDiscordContent,
  splitIntoChunks,
  type ImageAttachment,
  type MediaRefAttachment,
  type RenderOptions,
} from './render.js'
export {
  SessionEventsManager,
  runStateToFrame,
  type OnRenderCallback,
  type OnRunQueuedCallback,
  type RunState,
} from './session-events-manager.js'
export type {
  DiscordInterfaceBinding,
  GatewaySessionEvent,
  PermissionAction,
  RenderAction,
  RenderBlock,
  RenderFrame,
  SessionEventEnvelope,
  UiHandle,
} from './types.js'
