import { describe, expect, mock, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import {
  bindAcpHostListeners,
  formatStartupLine,
  isEnabledEnvFlag,
  renderHelp,
  resolveBindHosts,
  resolveCliOptions,
  resolveLauncherDeps,
  resolveRealLauncherAgentRoot,
  resolveRealLauncherPlacement,
} from '../src/cli.js'
import type { FetchPlacementResolution } from '../src/placement-resolution.js'

describe('acp-server cli helpers', () => {
  test('resolves defaults from environment', () => {
    const resolved = resolveCliOptions([], {
      WRKQ_DB_PATH: '/tmp/wrkq.db',
      WRKQ_ACTOR: 'wrkq-default',
    })

    expect(resolved.help).toBe(false)
    expect(resolved.options).toEqual({
      wrkqDbLocator: '/tmp/wrkq.db',
      coordDbPath: '/Users/lherron/praesidium/var/db/acp-coordination.db',
      interfaceDbPath: '/Users/lherron/praesidium/var/db/acp-interface.db',
      stateDbPath: '/Users/lherron/praesidium/var/db/acp-state.db',
      agentAssetsDir: '/Users/lherron/praesidium/var/state/acp-server/assets/agents',
      host: '127.0.0.1',
      port: 18470,
      actor: 'wrkq-default',
    })
  })

  test('flags override environment values', () => {
    const resolved = resolveCliOptions(
      [
        '--wrkq-db-path',
        '/tmp/override-wrkq.db',
        '--coord-db-path',
        '/tmp/coord.db',
        '--interface-db-path',
        '/tmp/interface.db',
        '--state-db-path',
        '/tmp/state.db',
        '--host',
        '127.0.0.1, 100.73.60.81',
        '--port',
        '19000',
        '--actor',
        'cli-actor',
      ],
      {
        WRKQ_DB_PATH: '/tmp/wrkq.db',
        ACP_COORD_DB_PATH: '/tmp/env-coord.db',
        ACP_INTERFACE_DB_PATH: '/tmp/env-interface.db',
        ACP_STATE_DB_PATH: '/tmp/env-state.db',
        ACP_HOST: '127.0.0.9',
        ACP_PORT: '18000',
        ACP_ACTOR: 'env-actor',
      }
    )

    expect(resolved.options).toEqual({
      wrkqDbLocator: '/tmp/override-wrkq.db',
      coordDbPath: '/tmp/coord.db',
      interfaceDbPath: '/tmp/interface.db',
      stateDbPath: '/tmp/state.db',
      agentAssetsDir: '/Users/lherron/praesidium/var/state/acp-server/assets/agents',
      host: '127.0.0.1,100.73.60.81',
      port: 19000,
      actor: 'cli-actor',
    })
  })

  describe('canonical wrkq locator configuration', () => {
    test('resolves the full precedence table, ignores blank candidates, and never selects WRKF_DB_PATH', () => {
      const cases: Array<{
        name: string
        args: string[]
        env: NodeJS.ProcessEnv
        expected: string
      }> = [
        {
          name: '--wrkq-db wins over every lower-precedence input',
          args: ['--wrkq-db', '/cli-locator.db'],
          env: {
            ACP_WRKQ_DB: '/acp-locator.db',
            WRKQ_DB: '/wrkq-locator.db',
            ACP_WRKQ_DB_PATH: '/acp-path.db',
            WRKQ_DB_PATH: '/wrkq-path.db',
          },
          expected: '/cli-locator.db',
        },
        {
          name: '--wrkq-db-path wins over locator and path environment inputs',
          args: ['--wrkq-db-path', '/cli-path.db'],
          env: {
            ACP_WRKQ_DB: '/acp-locator.db',
            WRKQ_DB: '/wrkq-locator.db',
            ACP_WRKQ_DB_PATH: '/acp-path.db',
            WRKQ_DB_PATH: '/wrkq-path.db',
          },
          expected: '/cli-path.db',
        },
        {
          name: 'ACP_WRKQ_DB wins over WRKQ_DB and path environment inputs',
          args: [],
          env: {
            ACP_WRKQ_DB: ' rpc://acp:7171 ',
            WRKQ_DB: 'rpc://wrkq:7171',
            ACP_WRKQ_DB_PATH: '/acp-path.db',
            WRKQ_DB_PATH: '/wrkq-path.db',
          },
          expected: 'rpc://acp:7171',
        },
        {
          name: 'WRKQ_DB wins over path environment inputs and divergent WRKF_DB_PATH',
          args: [],
          env: {
            WRKQ_DB: 'rpc://wrkq:7171',
            ACP_WRKQ_DB_PATH: '/acp-path.db',
            WRKQ_DB_PATH: '/wrkq-path.db',
            WRKF_DB_PATH: '/divergent-wrkf.db',
          },
          expected: 'rpc://wrkq:7171',
        },
        {
          name: 'ACP_WRKQ_DB_PATH wins over WRKQ_DB_PATH',
          args: [],
          env: { ACP_WRKQ_DB_PATH: '/acp-path.db', WRKQ_DB_PATH: '/wrkq-path.db' },
          expected: '/acp-path.db',
        },
        {
          name: 'WRKQ_DB_PATH is the final compatibility fallback',
          args: [],
          env: { WRKQ_DB_PATH: '/wrkq-path.db' },
          expected: '/wrkq-path.db',
        },
        {
          name: 'blank higher-precedence values are absent and fall through',
          args: ['--wrkq-db', ' ', '--wrkq-db-path', '\t'],
          env: {
            ACP_WRKQ_DB: ' ',
            WRKQ_DB: '\t',
            ACP_WRKQ_DB_PATH: '\n',
            WRKQ_DB_PATH: ' /fallback.db ',
          },
          expected: '/fallback.db',
        },
      ]

      for (const { name, args, env, expected } of cases) {
        expect(resolveCliOptions(args, env).options.wrkqDbLocator, name).toBe(expected)
      }

      expect(() =>
        resolveCliOptions(['--wrkq-db', ' ', '--wrkq-db-path', '\t'], {
          ACP_WRKQ_DB: ' ',
          WRKQ_DB: '\t',
          ACP_WRKQ_DB_PATH: '\n',
          WRKQ_DB_PATH: '',
        })
      ).toThrow('wrkq database locator is required')
    })

    test('permits equal local dual flags and rejects differing dual flags', () => {
      expect(
        resolveCliOptions(['--wrkq-db', '/same.db', '--wrkq-db-path', '/same.db'], {}).options
          .wrkqDbLocator
      ).toBe('/same.db')

      expect(() =>
        resolveCliOptions(['--wrkq-db', '/canonical.db', '--wrkq-db-path', '/legacy.db'], {})
      ).toThrow('conflict')
    })

    test('rejects rpc:// on every path-named compatibility input, even beside an equal canonical locator', () => {
      const cases: Array<{ name: string; args: string[]; env: NodeJS.ProcessEnv }> = [
        {
          name: '--wrkq-db-path',
          args: ['--wrkq-db', 'rpc://mini:7171', '--wrkq-db-path', 'rpc://mini:7171'],
          env: {},
        },
        {
          name: 'ACP_WRKQ_DB_PATH',
          args: ['--wrkq-db', 'rpc://mini:7171'],
          env: { ACP_WRKQ_DB_PATH: 'rpc://mini:7171' },
        },
        {
          name: 'WRKQ_DB_PATH',
          args: [],
          env: { WRKQ_DB: 'rpc://mini:7171', WRKQ_DB_PATH: 'rpc://mini:7171' },
        },
      ]

      for (const { name, args, env } of cases) {
        expect(() => resolveCliOptions(args, env), name).toThrow('path-only')
      }
    })
  })

  test('parses and validates comma-separated bind hosts', () => {
    expect(resolveBindHosts('127.0.0.1, 100.73.60.81')).toEqual(['127.0.0.1', '100.73.60.81'])
    expect(() =>
      resolveCliOptions([], { WRKQ_DB_PATH: '/tmp/wrkq.db', ACP_HOST: '0.0.0.0' })
    ).toThrow('must not bind 0.0.0.0')
    expect(() => resolveBindHosts('127.0.0.1,')).toThrow('non-empty hosts')
  })

  test('binds one listener per host and closes partial binds on failure', () => {
    const stopped: string[] = []
    const bound = bindAcpHostListeners(
      ['127.0.0.1', '100.73.60.81'],
      (host) => ({
        host,
        stop: () => {
          stopped.push(host)
        },
      }),
      18470
    )

    expect(bound.map((server) => server.host)).toEqual(['127.0.0.1', '100.73.60.81'])
    expect(stopped).toEqual([])

    const stoppedAfterFailure: string[] = []
    expect(() =>
      bindAcpHostListeners(
        ['127.0.0.1', '100.73.60.81'],
        (host) => {
          if (host === '100.73.60.81') {
            throw new Error('EADDRNOTAVAIL')
          }
          return {
            stop: () => {
              stoppedAfterFailure.push(host)
            },
          }
        },
        18470
      )
    ).toThrow('failed to bind ACP server listener on 100.73.60.81:18470: EADDRNOTAVAIL')
    expect(stoppedAfterFailure).toEqual(['127.0.0.1'])
  })

  test('formats startup output and help text', () => {
    expect(
      formatStartupLine({
        wrkqDbLocator: 'rpc://mini:7171',
        coordDbPath: '/tmp/coord.db',
        interfaceDbPath: '/tmp/interface.db',
        stateDbPath: '/tmp/state.db',
        agentAssetsDir: '/tmp/assets/agents',
        host: '127.0.0.1,100.73.60.81',
        port: 18470,
        actor: 'acp-server',
      })
    ).toContain('wrkq.locator = rpc://mini:7171')
    expect(
      formatStartupLine({
        wrkqDbLocator: '/tmp/wrkq.db',
        coordDbPath: '/tmp/coord.db',
        interfaceDbPath: '/tmp/interface.db',
        stateDbPath: '/tmp/state.db',
        agentAssetsDir: '/tmp/assets/agents',
        host: '127.0.0.1,100.73.60.81',
        port: 18470,
        actor: 'acp-server',
      })
    ).toContain('acp-server listening on http://127.0.0.1:18470, http://100.73.60.81:18470')
    expect(renderHelp()).toContain('acp-server')
    expect(renderHelp()).toContain('--wrkq-db <locator>')
    expect(renderHelp()).toContain('--wrkq-db-path <path>')
    expect(renderHelp()).toContain('ACP_WRKQ_DB')
    expect(renderHelp()).toContain('WRKQ_DB')
    expect(renderHelp()).toContain('ACP_WRKQ_DB_PATH')
    expect(renderHelp()).toContain('WRKQ_DB_PATH')
    expect(renderHelp()).not.toContain('WRKF_DB_PATH')
    expect(renderHelp()).toContain('ACP_INTERFACE_DB_PATH')
    expect(renderHelp()).toContain('ACP_STATE_DB_PATH')
    expect(renderHelp()).toContain('ACP_SCHEDULER_ENABLED')
    expect(renderHelp()).toContain('Comma-separated bind host list')
  })

  test('treats 1 and true as enabled scheduler flags', () => {
    expect(isEnabledEnvFlag('1')).toBe(true)
    expect(isEnabledEnvFlag('true')).toBe(true)
    expect(isEnabledEnvFlag('TRUE')).toBe(true)
    expect(isEnabledEnvFlag('0')).toBe(false)
    expect(isEnabledEnvFlag(undefined)).toBe(false)
  })

  test('real launcher resolves the daemon agent root for an agent id', async () => {
    const seen: unknown[] = []
    const fetchPlacement: FetchPlacementResolution = async (input) => {
      seen.push(input)
      return {
        agentRoot: '/agents/rex',
        cwd: '/agents/rex',
        bundle: { kind: 'agent-project', agentName: 'rex' },
        harness: { provider: 'anthropic', interactive: true },
      }
    }

    const agentRoot = await resolveRealLauncherAgentRoot('rex', {
      cwd: '/tmp/daemon-cwd',
      fetchPlacement,
    })

    expect(agentRoot).toBe('/agents/rex')
    expect(seen).toEqual([{ agentId: 'rex', cwd: '/tmp/daemon-cwd' }])
  })

  test('real launcher surfaces the daemon refusal for an unknown agent', async () => {
    const fetchPlacement: FetchPlacementResolution = async () => {
      throw new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, 'agent "rex" was not found', {
        source: 'agent-profile',
      })
    }

    await expect(resolveRealLauncherAgentRoot('rex', { fetchPlacement })).rejects.toThrow(
      'agent "rex" was not found'
    )
  })

  test('real launcher placement maps the daemon resolution to a runtime placement', async () => {
    const agentRoot = '/agents/cody'
    const projectRoot = '/projects/agent-spaces'
    const seen: unknown[] = []
    const fetchPlacement: FetchPlacementResolution = async (input) => {
      seen.push(input)
      return {
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        bundle: { kind: 'agent-project', agentName: 'cody', projectRoot },
        harness: { provider: 'openai', interactive: true },
      }
    }

    const placement = await resolveRealLauncherPlacement(
      {
        scopeRef: 'agent:cody:project:agent-spaces:task:discord',
        laneRef: 'main',
      },
      { cwd: '/daemon/cwd', fetchPlacement }
    )

    expect(placement).toEqual({
      agentRoot,
      projectRoot,
      cwd: projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'cody', projectRoot },
    })
    expect(seen).toEqual([
      {
        scopeRef: 'agent:cody:project:agent-spaces:task:discord',
        cwd: '/daemon/cwd',
        runMode: 'task',
      },
    ])
  })

  test('real launcher refuses a project scope the daemon returns without a project root', async () => {
    const fetchPlacement: FetchPlacementResolution = async () => ({
      agentRoot: '/agents/mable',
      cwd: '/agents/mable',
      bundle: { kind: 'agent-project', agentName: 'mable' },
      harness: { provider: 'anthropic', interactive: true },
    })

    await expect(
      resolveRealLauncherPlacement(
        {
          scopeRef: 'agent:mable:project:missing-project:task:primary-nova',
          laneRef: 'main',
        },
        { fetchPlacement }
      )
    ).resolves.toBeUndefined()
  })

  test('real launcher surfaces the daemon refusal instead of minting an agent-home placement', async () => {
    const fetchPlacement: FetchPlacementResolution = async () => {
      throw new HrcDomainError(
        HrcErrorCode.DECLARATION_INVALID,
        'project root unknown for missing-project; register it with: wrkq set missing-project --root <path>',
        { source: 'project-targets' }
      )
    }

    await expect(
      resolveRealLauncherPlacement(
        {
          scopeRef: 'agent:mable:project:missing-project:task:primary-nova',
          laneRef: 'main',
        },
        { fetchPlacement }
      )
    ).rejects.toThrow('project root unknown for missing-project')
  })

  test('real launcher wins over echo launcher and warns on conflicts', () => {
    const warn = mock(() => {})
    const originalWarn = console.warn

    try {
      console.warn = warn as typeof console.warn

      const deps = resolveLauncherDeps(
        {
          ACP_REAL_HRC_LAUNCHER: '1',
          ACP_DEV_ECHO_LAUNCHER: '1',
        },
        '/tmp/acp-cli'
      )

      expect(deps.launchRoleScopedRun).toBeDefined()
      expect(deps.runtimeResolver).toBeDefined()
      expect(deps.agentRootResolver).toBeDefined()
      expect(deps.runLivenessResolver).toBeDefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = originalWarn
    }
  })
})
