import { describe, expect, test } from 'bun:test'

import { runCli } from './cli-test-helpers.js'

describe('acp CLI help', () => {
  test('top-level help lists the new command families', async () => {
    const result = await runCli(['--help'])

    expect(result.exitCode).toBe(0)
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

  test('nested help is usable for new commands', async () => {
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
})
