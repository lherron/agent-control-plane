import type { DiscordInterfaceBinding } from './types.js'

export type DiscordConversationLookup = {
  conversationRef: string
  threadRef?: string | undefined
}

function parseDiscordRef(ref: string, prefix: string): string | undefined {
  return ref.startsWith(`${prefix}:`) ? ref.slice(prefix.length + 1) : undefined
}

export function conversationKey(lookup: DiscordConversationLookup): string {
  return [lookup.conversationRef, lookup.threadRef ?? ''].join('|')
}

export class BindingIndex {
  private byKey = new Map<string, DiscordInterfaceBinding>()

  replaceAll(bindings: DiscordInterfaceBinding[]): void {
    this.byKey = new Map(bindings.map((binding) => [conversationKey(binding), binding]))
  }

  getBindingFor(lookup: DiscordConversationLookup): DiscordInterfaceBinding | undefined {
    const exact = this.byKey.get(conversationKey(lookup))
    if (exact) {
      return exact
    }

    if (!lookup.threadRef) {
      return undefined
    }

    return this.byKey.get(
      conversationKey({
        conversationRef: lookup.conversationRef,
      })
    )
  }
}

export function toConversationRefs(input: {
  channelId: string
  threadId?: string | undefined
}): DiscordConversationLookup {
  return {
    conversationRef: `channel:${input.channelId}`,
    ...(input.threadId !== undefined ? { threadRef: `thread:${input.threadId}` } : {}),
  }
}

export function conversationRefToChannelId(conversationRef: string): string | undefined {
  return parseDiscordRef(conversationRef, 'channel')
}

export function threadRefToThreadId(threadRef: string | undefined): string | undefined {
  return threadRef === undefined ? undefined : parseDiscordRef(threadRef, 'thread')
}
