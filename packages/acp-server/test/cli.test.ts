import { describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  formatStartupLine,
  isEnabledEnvFlag,
  renderHelp,
  resolveCliOptions,
  resolveLauncherDeps,
  resolveRealLauncherAgentRoot,
  resolveRealLauncherPlacement,
} from '../src/cli.js'

describe('acp-server cli helpers', () => {
  test('resolves defaults from environment', () => {
    const resolved = resolveCliOptions([], {
      WRKQ_DB_PATH: '/tmp/wrkq.db',
      WRKQ_ACTOR: 'wrkq-default',
    })

    expect(resolved.help).toBe(false)
    expect(resolved.options).toEqual({
      wrkqDbPath: '/tmp/wrkq.db',
      coordDbPath: '/Users/lherron/praesidium/var/db/acp-coordination.db',
      interfaceDbPath: '/Users/lherron/praesidium/var/db/acp-interface.db',
      stateDbPath: '/Users/lherron/praesidium/var/db/acp-state.db',
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
        '0.0.0.0',
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
      wrkqDbPath: '/tmp/override-wrkq.db',
      coordDbPath: '/tmp/coord.db',
      interfaceDbPath: '/tmp/interface.db',
      stateDbPath: '/tmp/state.db',
      host: '0.0.0.0',
      port: 19000,
      actor: 'cli-actor',
    })
  })

  test('formats startup output and help text', () => {
    expect(
      formatStartupLine({
        wrkqDbPath: '/tmp/wrkq.db',
        coordDbPath: '/tmp/coord.db',
        interfaceDbPath: '/tmp/interface.db',
        stateDbPath: '/tmp/state.db',
        host: '127.0.0.1',
        port: 18470,
        actor: 'acp-server',
      })
    ).toContain('wrkq.db = /tmp/wrkq.db')
    expect(renderHelp()).toContain('acp-server')
    expect(renderHelp()).toContain('ACP_WRKQ_DB_PATH')
    expect(renderHelp()).toContain('ACP_INTERFACE_DB_PATH')
    expect(renderHelp()).toContain('ACP_STATE_DB_PATH')
    expect(renderHelp()).toContain('ACP_SCHEDULER_ENABLED')
  })

  test('treats 1 and true as enabled scheduler flags', () => {
    expect(isEnabledEnvFlag('1')).toBe(true)
    expect(isEnabledEnvFlag('true')).toBe(true)
    expect(isEnabledEnvFlag('TRUE')).toBe(true)
    expect(isEnabledEnvFlag('0')).toBe(false)
    expect(isEnabledEnvFlag(undefined)).toBe(false)
  })

  test('real launcher resolves canonical agents root before asp_modules fallback', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-cli-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cli-cwd-'))

    try {
      mkdirSync(join(home, 'praesidium', 'var', 'agents', 'rex'), { recursive: true })
      mkdirSync(join(cwd, 'asp_modules', 'rex', 'claude'), { recursive: true })

      expect(
        resolveRealLauncherAgentRoot('rex', {
          cwd,
          env: {
            HOME: home,
            ASP_AGENTS_ROOT: join(home, 'praesidium', 'var', 'agents'),
          },
        })
      ).toBe(join(home, 'praesidium', 'var', 'agents', 'rex'))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('real launcher falls back to asp_modules claude root when no agents root exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cli-cwd-'))

    try {
      mkdirSync(join(cwd, 'asp_modules', 'rex', 'claude'), { recursive: true })

      expect(
        resolveRealLauncherAgentRoot('rex', {
          cwd,
          env: {
            HOME: join(cwd, 'missing-home'),
            ASP_AGENTS_ROOT: join(cwd, 'missing-agents-root'),
          },
        })
      ).toBe(join(cwd, 'asp_modules', 'rex', 'claude'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('real launcher placement resolves project root and cwd from scope projectId', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'acp-cli-placement-'))
    const agentsRoot = join(workspace, 'agents')
    const projectsRoot = join(workspace, 'projects')
    const agentRoot = join(agentsRoot, 'cody')
    const projectRoot = join(projectsRoot, 'agent-spaces')

    try {
      mkdirSync(agentRoot, { recursive: true })
      mkdirSync(projectRoot, { recursive: true })

      const placement = resolveRealLauncherPlacement(
        {
          scopeRef: 'agent:cody:project:agent-spaces:task:discord',
          laneRef: 'main',
        },
        {
          env: {
            ASP_AGENTS_ROOT: agentsRoot,
            ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
          },
        }
      )

      expect(placement).toEqual({
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
        bundle: { kind: 'agent-default' },
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
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
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = originalWarn
    }
  })
})
