import { describe, expect, test } from 'bun:test'

import { formatStartupLine, renderHelp, resolveCliOptions } from '../src/cli.js'

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
        ACP_HOST: '127.0.0.9',
        ACP_PORT: '18000',
        ACP_ACTOR: 'env-actor',
      }
    )

    expect(resolved.options).toEqual({
      wrkqDbPath: '/tmp/override-wrkq.db',
      coordDbPath: '/tmp/coord.db',
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
        host: '127.0.0.1',
        port: 18470,
        actor: 'acp-server',
      })
    ).toContain('wrkq.db = /tmp/wrkq.db')
    expect(renderHelp()).toContain('acp-server')
    expect(renderHelp()).toContain('ACP_WRKQ_DB_PATH')
  })
})
