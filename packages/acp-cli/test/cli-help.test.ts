import { describe, expect, test } from 'bun:test'

import { runCli } from './cli-test-helpers.js'

describe('acp CLI help', () => {
  test('top-level --help prints usage and lists every command family', async () => {
    const result = await runCli(['--help'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+acp/i)
    expect(result.stdout).toContain('task')
    expect(result.stdout).toContain('action')
    expect(result.stdout).toContain('runtime')
    expect(result.stdout).toContain('session')
    expect(result.stdout).toContain('send')
    expect(result.stdout).toContain('tail')
    expect(result.stdout).toContain('render')
    expect(result.stdout).toContain('message')
    expect(result.stdout).toContain('job-run')
    expect(result.stdout).toContain('heartbeat')
    expect(result.stdout).toContain('delivery')
    expect(result.stdout).toContain('thread')
  })

  test('session attach-command, message send and heartbeat wake --help exit 0 with their descriptions', async () => {
    const sessionHelp = await runCli(['session', 'attach-command', '--help'])
    expect(sessionHelp.exitCode).toBe(0)
    expect(sessionHelp.stdout).toContain('get a session attach command')

    const messageHelp = await runCli(['message', 'send', '--help'])
    expect(messageHelp.exitCode).toBe(0)
    expect(messageHelp.stdout).toContain('send coordination message')

    const heartbeatHelp = await runCli(['heartbeat', 'wake', '--help'])
    expect(heartbeatHelp.exitCode).toBe(0)
    expect(heartbeatHelp.stdout).toContain('trigger one wake request')
  })

  test('server help uses the full runtime help for both command forms', async () => {
    for (const args of [
      ['server', '--help'],
      ['server', 'serve', '--help'],
    ]) {
      const result = await runCli(args)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('acp server serve [options]')
      expect(result.stdout).toContain('Environment:')
      expect(result.stdout).toContain('ACP_ACCESS_LOG_PATH')
      // Combined HTTP plus Discord process surface (folded from server-runtime.test.ts).
      expect(result.stdout).toContain('--no-discord')
      expect(result.stdout).toContain('Comma-separated bind host list')
      expect(result.stdout).toContain('ACP_DISCORD_RETAIN_TURN_PROGRESS=0')
      expect(result.stdout).toContain('bootout/bootstrap')
    }
  })
})
