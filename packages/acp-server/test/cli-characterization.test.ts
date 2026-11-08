import { expect, test } from 'bun:test'
import { resolveCliOptions, resolveLauncherDeps } from '../src/cli.js'

test('optional stores distinguish absent, blank sibling, and explicit trimmed paths', () => {
  for (const [value, expected] of [
    [undefined, undefined],
    ['  ', '/tmp/cli/acp-jobs.db'],
    [' /tmp/custom.db ', '/tmp/custom.db'],
  ] as const) {
    const options = resolveCliOptions([], {
      WRKQ_DB: '/tmp/wrkq.db',
      ACP_INTERFACE_DB_PATH: '/tmp/cli/interface.db',
      ...(value !== undefined ? { ACP_JOBS_DB_PATH: value } : {}),
    }).options
    expect(options.jobsDbPath).toBe(expected)
    expect(Object.hasOwn(options, 'jobsDbPath')).toBe(expected !== undefined)
  }
})

test('port parsing retains numeric prefixes and the env zero value', () => {
  for (const [args, port, expected] of [
    [[], '0', 0],
    [[], '19001suffix', 19001],
    [[], 'invalid', 18470],
    [['--port', '19002suffix'], '19001', 19002],
  ] as const) {
    expect(resolveCliOptions(args, { WRKQ_DB: '/tmp/wrkq.db', ACP_PORT: port }).options.port).toBe(
      expected
    )
  }
  expect(() => resolveCliOptions(['--port', '0'], {})).toThrow('positive integer')
})

test('help bypasses a missing locator but retains input validation', () => {
  expect(resolveCliOptions(['--help'], {}).options.wrkqDbLocator).toBe('')
  expect(() => resolveCliOptions(['--help'], { ACP_HOST: '::' })).toThrow('must not bind')
})

test('launcher defaults are inert and dev flow takes precedence over echo', async () => {
  expect(resolveLauncherDeps({})).toEqual({})
  const deps = resolveLauncherDeps({ ACP_DEV_FLOW_LAUNCHER: '1', ACP_DEV_ECHO_LAUNCHER: '1' })
  expect(await deps.agentRootResolver?.({ agentId: 'cody' } as never)).toBe(
    '/tmp/acp-dev-flow/cody'
  )
  expect(deps.hrcClient).toBeUndefined()
})
