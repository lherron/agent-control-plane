// Re-export the shared projection pipeline from hrc-frame-render.
// The SessionEventsManager class is extended here only to preserve the
// legacy setDiscordMessage() API used by gateway-discord sinks.

import { SessionEventsManager as BaseSessionEventsManager } from 'hrc-frame-render'

export {
  runStateToFrame,
  type AssistantSegment,
  type OnRenderCallback,
  type OnRunQueuedCallback,
  type RunState,
} from 'hrc-frame-render'

/**
 * Discord-aware extension of the shared SessionEventsManager.
 * Adds the `setDiscordMessage()` convenience method that stashes
 * Discord message/channel IDs into the run's opaque sinkMetadata.
 */
export class SessionEventsManager extends BaseSessionEventsManager {
  /**
   * @deprecated Use setSinkMetadata() instead for new sinks.
   * Preserved for backward compatibility with existing Discord rendering code.
   */
  setDiscordMessage(sessionRef: string, runId: string, messageId: string, channelId: string): void {
    this.setSinkMetadata(sessionRef, runId, {
      discordMessageId: messageId,
      discordChannelId: channelId,
    })
  }
}
