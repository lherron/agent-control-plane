import type { DiscordConversationLookup } from './bindings.js'

export type DiscordKeywordDefinition = {
  keyword: string
  aliases?: readonly string[] | undefined
  match: 'first-token'
}

export type ParsedDiscordKeyword = {
  keyword: string
  canonicalKeyword: string
  content: string
}

export type KeywordRoute = {
  content: string
  conversation: DiscordConversationLookup
  targetChannelId: string
  targetThreadId?: string | undefined
}

export const defaultDiscordKeywordDefinitions = [
  {
    keyword: 'nt',
    match: 'first-token',
  },
] as const satisfies readonly DiscordKeywordDefinition[]

export function parseDiscordKeyword(
  content: string,
  definitions: readonly DiscordKeywordDefinition[] = defaultDiscordKeywordDefinitions
): ParsedDiscordKeyword | undefined {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  const [rawToken] = trimmed.split(/\s+/, 1)
  const normalizedToken = rawToken?.toLowerCase()
  const definition = definitions.find(
    (entry) =>
      entry.match === 'first-token' &&
      (entry.keyword.toLowerCase() === normalizedToken ||
        entry.aliases?.some((alias) => alias.toLowerCase() === normalizedToken) === true)
  )
  if (rawToken === undefined || definition === undefined) {
    return undefined
  }

  return {
    keyword: rawToken,
    canonicalKeyword: definition.keyword,
    content: trimmed.slice(rawToken.length).trimStart(),
  }
}

export function buildDiscordThreadLaneRef(threadId: string): `lane:${string}` {
  return `lane:discord-${threadId}`
}

export function buildDiscordThreadName(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) {
    return 'New thread'
  }
  if (normalized.length <= 100) {
    return normalized
  }
  return `${normalized.slice(0, 97)}...`
}
