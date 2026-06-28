/**
 * E2E gate — Node Z, contract C-0009: cross-implementation equivalence between
 * wrkq's Go `normalizeExternalRunRef` and acp-core's shared TS
 * `formatHrcExternalRef`, driven through the REAL `wrkf` binary.
 *
 * wrkq (Go) and ACP (TS) each independently turn a bare HRC run id into the
 * stored external ref `hrc:<id>`:
 *   - Go  internal/workflow/action.go `normalizeExternalRunRef`: bare (no ":")
 *     → "hrc:" + ref; a value already carrying a scheme (contains ":") is
 *     preserved; empty stays empty.
 *   - TS  acp-core `formatHrcExternalRef`: trims; throws on empty; throws on an
 *     already-`hrc:`-prefixed input; otherwise → "hrc:" + trimmed.
 *
 * If these two prefixings ever drift, a binding written by one and read by the
 * other would mismatch. This test catches that drift by binding a BARE id through
 * the real wrkf binary (which runs the Go normalizer) and asserting the stored
 * ref is BYTE-IDENTICAL to what the TS formatter produces from the same bare id.
 *
 * Equivalence DOMAIN (where the two implementations are provably identical):
 *   non-empty bare ids WITHOUT a scheme (no ":"). For these, Go → "hrc:"+ref and
 *   TS → "hrc:"+trimmed are byte-identical. The corpus below lives entirely in
 *   this domain.
 *
 * Documented DIVERGENCE outside the domain (and why it is safe in practice):
 *   - empty / whitespace: Go preserves "" (no-op); TS THROWS. ACP never stores an
 *     empty ref — it only ever formats a real HRC run id — so the throw is the
 *     correct guard and the divergence is unreachable in production.
 *   - already-prefixed "hrc:foo": Go preserves it verbatim (it contains ":"); TS
 *     THROWS (a bare id is required). These CONVERGE on the same stored bytes
 *     because ACP ALWAYS formats the bare id BEFORE storage: TS
 *     formatHrcExternalRef('foo') === 'hrc:foo', and binding the already-prefixed
 *     'hrc:foo' through wrkf also stores 'hrc:foo' (idempotent) — same bytes.
 *
 * Binaries (overridable): WRKF_BIN / WRKQ_BIN / WRKQADM_BIN default ~/.local/bin.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { HRC_EXTERNAL_REF_PREFIX, formatHrcExternalRef } from 'acp-core'
import {
  type WrkfActionLaunchDeps,
  type WrkfLifecycle,
  createWrkfClientLifecycle,
} from 'acp-server'

const HOME = process.env['HOME'] ?? '/Users/lherron'
const WRKF_BIN = process.env['WRKF_BIN'] ?? `${HOME}/.local/bin/wrkf`
const WRKQ_BIN = process.env['WRKQ_BIN'] ?? `${HOME}/.local/bin/wrkq`
const WRKQADM_BIN = process.env['WRKQADM_BIN'] ?? `${HOME}/.local/bin/wrkqadm`

const ACTION = 'implement'
const ACTOR = 'agent:curly-e2e'

const T = 30_000

// Bare HRC run ids spanning the equivalence domain: none contains ":". Mixes
// run-style ids, an hsid-style host session id, dots/underscores, and a pure
// numeric — all of which Go prefixes and TS formats identically.
const BARE_ID_CORPUS = [
  'hrc-run-001',
  'hsid-2a328a95-3bf3-429e-9684-b75d066edf77',
  'run-c8d3f591-4576-4481-a19d-ed2e9b34d503',
  'RUN_with.dots-and_underscores',
  '12345',
] as const

type ActionRunRecord = {
  actionRunId: string
  runId: string
  externalRunRef?: string
  status: string
}
type RawActionClient = {
  wrkf: { action: { list(params: { task: string }): Promise<{ items: ActionRunRecord[] }> } }
}

describe('hrc external-ref cross-impl equivalence — real wrkf e2e (C-0009)', () => {
  let tmpDir: string
  let dbPath: string
  let lc: WrkfLifecycle
  let childEnv: Record<string, string | undefined>
  const seededTaskIds: string[] = []

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-hrc-extref-equiv-'))
    dbPath = join(tmpDir, 'wrkq.db')
    childEnv = { ...process.env, ASP_PROJECT: undefined, WRKQ_DB_PATH: undefined }

    const init = Bun.spawnSync([WRKQADM_BIN, '--db', dbPath, 'init'], {
      cwd: tmpDir,
      env: childEnv,
    })
    if (init.exitCode !== 0) {
      throw new Error(`wrkqadm init failed: ${init.stderr.toString()} ${init.stdout.toString()}`)
    }

    lc = await createWrkfClientLifecycle({
      command: WRKF_BIN,
      dbPath,
      clientInfo: { name: 'hrc-extref-equiv-e2e', version: '0.1.0' },
    })
  })

  afterAll(async () => {
    await lc?.close()
    closeSeededTasks()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function wrkfPort(): WrkfActionLaunchDeps['wrkf'] {
    const port = lc.wrkf
    if (port === undefined) {
      throw new Error('wrkf port not available')
    }
    return port
  }

  function rawClient(): RawActionClient {
    const client = lc.client as unknown as RawActionClient | undefined
    if (client === undefined) {
      throw new Error('wrkf client not available')
    }
    return client
  }

  function seedTask(slug: string): string {
    const touch = Bun.spawnSync(
      [WRKQ_BIN, '--db', dbPath, '--as', 'local-human', 'touch', '--project', 'inbox', slug],
      { cwd: tmpDir, env: childEnv }
    )
    const out = `${touch.stdout.toString()} ${touch.stderr.toString()}`
    const match = out.match(/(T-\d+)/)
    if (!match) {
      throw new Error(`wrkq touch failed: ${out}`)
    }
    const taskId = match[1] as string
    seededTaskIds.push(taskId)
    return taskId
  }

  function closeSeededTasks(): void {
    if (dbPath === undefined || childEnv === undefined) {
      return
    }
    for (const taskId of seededTaskIds) {
      const result = Bun.spawnSync(
        [
          WRKQ_BIN,
          '--db',
          dbPath,
          '--as',
          'local-human',
          'set',
          taskId,
          '--state',
          'completed',
          '--resolution',
          'done',
        ],
        { cwd: tmpDir, env: childEnv }
      )
      if (result.exitCode !== 0) {
        throw new Error(
          `wrkq cleanup failed for ${taskId}: ${result.stderr.toString()} ${result.stdout.toString()}`
        )
      }
    }
  }

  async function listActionRuns(taskId: string): Promise<ActionRunRecord[]> {
    const res = await rawClient().wrkf.action.list({ task: taskId })
    return res.items
  }

  /** Start one action run on a fresh task and bind the given externalRunRef. */
  async function startAndBind(
    slug: string,
    externalRunRef: string,
    idempotencyKey: string
  ): Promise<string> {
    const taskId = seedTask(slug)
    const started = (await wrkfPort().action.start({
      task: taskId,
      action: ACTION,
      actor: ACTOR,
      idempotencyKey,
    })) as { actionRunId: string }
    await wrkfPort().action.bindExternal({
      actionRunId: started.actionRunId,
      externalRunRef,
      idempotencyKey: `${idempotencyKey}:bindExternal`,
    })
    const runs = await listActionRuns(taskId)
    expect(runs).toHaveLength(1)
    const stored = runs[0]?.externalRunRef
    if (stored === undefined) {
      throw new Error(`no stored externalRunRef for task ${taskId} (bound ${externalRunRef})`)
    }
    return stored
  }

  // ── Core equivalence: bare id through real wrkf == TS formatter, byte-identical
  for (const [index, bareId] of BARE_ID_CORPUS.entries()) {
    test(
      `bare id ${JSON.stringify(bareId)}: wrkf Go normalize === acp-core formatHrcExternalRef (byte-identical)`,
      async () => {
        const expected = formatHrcExternalRef(bareId)
        // Sanity: the TS formatter prefixes exactly the shared scheme.
        expect(expected).toBe(`${HRC_EXTERNAL_REF_PREFIX}${bareId}`)

        const stored = await startAndBind(`extref-equiv-${index}`, bareId, `equiv:${index}:001`)

        // The whole point: the Go binary's independently-computed stored ref is
        // byte-for-byte what the shared TS formatter produces from the same bare id.
        expect(stored).toBe(expected)
      },
      T
    )
  }

  // ── Domain boundary: TS formatter rejects empty / whitespace ────────────────
  test('formatHrcExternalRef throws on empty/whitespace (Go preserves "" — divergence is unreachable in prod)', () => {
    expect(() => formatHrcExternalRef('')).toThrow()
    expect(() => formatHrcExternalRef('   ')).toThrow()
  })

  // ── Domain boundary: TS formatter rejects an already-prefixed ref ───────────
  test('formatHrcExternalRef throws on an already-hrc:-prefixed ref (a bare id is required)', () => {
    expect(() => formatHrcExternalRef('hrc:foo')).toThrow()
  })

  // ── Convergence on already-prefixed: wrkf stores 'hrc:foo' unchanged, which
  //    equals formatHrcExternalRef('foo'). Both implementations land on the same
  //    bytes because ACP always formats the bare id BEFORE storage.
  test(
    "already-prefixed 'hrc:foo' stored unchanged by wrkf === formatHrcExternalRef('foo')",
    async () => {
      const stored = await startAndBind('extref-equiv-prefixed', 'hrc:foo', 'equiv:prefixed:001')
      // Go preserves the already-prefixed value verbatim (it contains ":").
      expect(stored).toBe('hrc:foo')
      // ...which is exactly what the TS formatter produces from the bare 'foo'.
      expect(stored).toBe(formatHrcExternalRef('foo'))
    },
    T
  )
})
