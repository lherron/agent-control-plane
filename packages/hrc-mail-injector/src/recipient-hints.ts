import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@iarna/toml'
import { getAgentRootsForProject, parseSpaceRef } from 'spaces-config'
import type { KickerLogLevel } from './policy/contracts.js'
import type { HintStyle } from './policy/ledger/presentation.js'

/** Local profile-only read, per T-12312. No daemon, compile, prompt or delivery retry. */
export class RecipientHints {
  private readonly cache = new Map<
    string,
    { stamp: string; contentHash: string; style: HintStyle }
  >()

  constructor(
    private readonly log: (
      level: KickerLogLevel,
      event: string,
      detail: Record<string, unknown>
    ) => void,
    private readonly roots: (projectRoot?: string) => string[] = getAgentRootsForProject
  ) {}

  forRecipient(agentId: string, projectRoot?: string): HintStyle {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error('invalid recipient agent id')
      for (const root of this.roots(projectRoot)) {
        const path = join(root, agentId, 'agent-profile.toml')
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const stamp = `${stat.mtimeMs}:${stat.size}`
        const cached = this.cache.get(path)
        if (cached?.stamp === stamp) return cached.style
        const content = readFileSync(path, 'utf8')
        const profile = parse(content)
        const spaces = profile['spaces']
        const base =
          spaces !== null &&
          typeof spaces === 'object' &&
          !Array.isArray(spaces) &&
          !(spaces instanceof Date)
            ? spaces['base']
            : undefined
        const member =
          Array.isArray(base) &&
          base.some((ref) => {
            if (typeof ref !== 'string') return false
            try {
              return parseSpaceRef(ref).id === 'prae-tools'
            } catch {
              return false
            }
          })
        const style = member ? 'prae' : 'legacy'
        const contentHash = createHash('sha256').update(content).digest('hex')
        this.cache.set(path, { stamp, contentHash, style })
        this.log('DEBUG', 'wrkq.kicker.recipient_hint_profile', {
          agentId,
          path,
          contentHash,
          style,
        })
        return style
      }
      throw new Error('recipient profile not found')
    } catch (error) {
      this.log('WARN', 'wrkq.kicker.recipient_hint_fallback', {
        agentId,
        reason: error instanceof Error ? error.message : String(error),
      })
      return 'legacy'
    }
  }
}
