import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dir, 'install-policy.ts')
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
)

let scratch: string
const checkouts: Record<'main' | 'linked-worktree', string> = { main: '', 'linked-worktree': '' }

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

/** Runs `install-policy.ts shell <flags>` from a checkout, as the justfile install recipe does. */
function runShell(cwd: string, flags: string[]) {
  const result = Bun.spawnSync([process.execPath, script, 'shell', ...flags], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function policyLines(policy: {
  context: string
  syncMode: string
  linkMode: string
  publishChannel: string
  publishTag: string
}): string {
  return [
    `PRAESIDIUM_INSTALL_CONTEXT='${policy.context}'`,
    `PRAESIDIUM_INSTALL_SYNC_MODE='${policy.syncMode}'`,
    `PRAESIDIUM_INSTALL_LINK_MODE='${policy.linkMode}'`,
    `PRAESIDIUM_INSTALL_PUBLISH_CHANNEL='${policy.publishChannel}'`,
    `PRAESIDIUM_INSTALL_PUBLISH_TAG='${policy.publishTag}'`,
    '',
  ].join('\n')
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'acp-install-policy-'))
  checkouts.main = join(scratch, 'repo')
  checkouts['linked-worktree'] = join(scratch, 'acp-T-05830')
  mkdirSync(checkouts.main)
  git(checkouts.main, 'init', '-q')
  git(
    checkouts.main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
  git(checkouts.main, 'worktree', 'add', '-q', checkouts['linked-worktree'])
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('install-policy shell', () => {
  test.each([
    {
      name: 'primary checkout keeps sync, wrapper linking and dev publishing on',
      checkout: 'main' as const,
      flags: [],
      policy: {
        context: 'main',
        syncMode: 'on',
        linkMode: 'on',
        publishChannel: 'dev',
        publishTag: 'latest',
      },
    },
    {
      name: 'linked worktree turns sync and linking off and publishes to the worktree channel',
      checkout: 'linked-worktree' as const,
      flags: [],
      policy: {
        context: 'linked-worktree',
        syncMode: 'off',
        linkMode: 'off',
        publishChannel: 'worktree',
        publishTag: 'worktree',
      },
    },
    {
      name: '--no-sync turns sync off in the primary checkout',
      checkout: 'main' as const,
      flags: ['--no-sync=1'],
      policy: {
        context: 'main',
        syncMode: 'off',
        linkMode: 'on',
        publishChannel: 'dev',
        publishTag: 'latest',
      },
    },
    {
      name: '--force-sync and --force-link force both side effects in a linked worktree',
      checkout: 'linked-worktree' as const,
      flags: ['--force-sync=1', '--force-link=true'],
      policy: {
        context: 'linked-worktree',
        syncMode: 'forced',
        linkMode: 'forced',
        publishChannel: 'worktree',
        publishTag: 'worktree',
      },
    },
  ])('$name', ({ checkout, flags, policy }) => {
    const result = runShell(checkouts[checkout], flags)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe(policyLines(policy))
  })

  test('contradictory --no-sync and --force-sync are refused with no policy emitted', () => {
    const result = runShell(checkouts['linked-worktree'], ['--no-sync=1', '--force-sync=1'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('no-sync and force-sync cannot both be enabled')
    expect(result.stdout).toBe('')
  })
})
