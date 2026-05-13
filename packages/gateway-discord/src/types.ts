import type { DeliveryRequest, InterfaceBinding } from 'acp-core'

// Re-export all neutral types from the shared package
export type {
  GatewayNoticeEvent,
  GatewayPermissionDecisionEvent,
  GatewayPermissionRequestEvent,
  GatewayRunCancelledEvent,
  GatewayRunCompletedEvent,
  GatewayRunFailedEvent,
  GatewayRunQueuedEvent,
  GatewayRunStartedEvent,
  GatewaySessionEvent,
  GatewaySessionMetadataEvent,
  PermissionAction,
  ProjectId,
  RenderAction,
  RenderBlock,
  RenderFrame,
  RunId,
  SessionEventEnvelope,
} from 'hrc-frame-render'

// Discord-specific types that stay in this package

export interface UiHandleMessage {
  gatewayId: string
  kind: 'message'
  id: string
  channelId?: string | undefined
  threadId?: string | undefined
  webhookId?: string | undefined
}

export interface UiHandleThread {
  gatewayId: string
  kind: 'thread'
  id: string
  channelId: string
}

export interface UiHandleStream {
  gatewayId: string
  kind: 'stream'
  id: string
}

export type UiHandle = UiHandleMessage | UiHandleThread | UiHandleStream

export type DiscordInterfaceBinding = InterfaceBinding & {
  verbose?: boolean | undefined
}

export type DeliveryStreamResponse = {
  deliveries: DeliveryRequest[]
  nextCursor: string | null
}
