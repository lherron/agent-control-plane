import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { writeLogLine } from '../index.js'

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function captureStreams() {
  const stdout: string[] = []
  const stderr: string[] = []
  spies.push(
    spyOn(console, 'log').mockImplementation((line: unknown) => {
      stdout.push(String(line))
    }),
    spyOn(console, 'warn').mockImplementation((line: unknown) => {
      stderr.push(String(line))
    }),
    spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(String(line))
    })
  )
  return { stdout, stderr }
}

describe('writeLogLine', () => {
  test('writes one standard-shape JSON line', () => {
    const { stdout } = captureStreams()

    writeLogLine({
      level: 'info',
      component: 'acp-server',
      event: 'server.listening',
      data: { pid: 1 },
    })

    expect(stdout).toHaveLength(1)
    expect(stdout[0]!).not.toContain('\n')
    expect(JSON.parse(stdout[0]!)).toEqual({
      level: 'info',
      component: 'acp-server',
      event: 'server.listening',
      data: { pid: 1 },
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    })
  })

  test('routes debug/info to stdout and warn/error to stderr unless a stream is named', () => {
    const { stdout, stderr } = captureStreams()

    writeLogLine({ level: 'info', component: 'c', event: 'a.b' })
    writeLogLine({ level: 'warn', component: 'c', event: 'a.b' })
    writeLogLine({ level: 'error', component: 'c', event: 'a.b' })
    writeLogLine({ level: 'warn', component: 'c', event: 'a.b' }, 'stdout')

    expect(stdout.map((line) => JSON.parse(line).level)).toEqual(['info', 'warn'])
    expect(stderr.map((line) => JSON.parse(line).level)).toEqual(['warn', 'error'])
  })

  test('omits empty data and serializes errors onto one line', () => {
    const { stderr, stdout } = captureStreams()

    writeLogLine({ level: 'info', component: 'c', event: 'a.b', data: {} })
    writeLogLine({ level: 'error', component: 'c', event: 'a.failed', err: new Error('one\ntwo') })

    expect(JSON.parse(stdout[0]!)).not.toHaveProperty('data')
    expect(stderr[0]!).not.toContain('\n')
    expect(JSON.parse(stderr[0]!).err).toMatchObject({ name: 'Error', message: 'one\ntwo' })
  })
})
