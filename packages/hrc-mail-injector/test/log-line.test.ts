import { describe, expect, test } from 'bun:test'

import { createJsonLineLog } from '../src/log-line.js'

function capture() {
  const lines: string[] = []
  const log = createJsonLineLog((chunk) => lines.push(chunk))
  return { lines, log }
}

describe('hrc-mail-injector log lines', () => {
  test('one standard-shape JSON object per line, event name kept', () => {
    const { lines, log } = capture()

    log('INFO', 'wrkq.kicker.presented', {
      envelope: 'EN-1',
      nested: { door: 'steer', ids: [1, 2] },
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith('\n')).toBe(true)
    expect(lines[0]!.slice(0, -1)).not.toContain('\n')
    const parsed = JSON.parse(lines[0]!)
    expect(parsed).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      level: 'info',
      component: 'hrc-mail-injector',
      event: 'wrkq.kicker.presented',
      data: { envelope: 'EN-1', nested: { door: 'steer', ids: [1, 2] } },
    })
  })

  test('maps every kicker level to the standard lowercase set', () => {
    const { lines, log } = capture()
    for (const level of ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const) log(level, 'e.v', { a: 1 })
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  test('an empty detail object writes no data key', () => {
    const { lines, log } = capture()
    log('INFO', 'wrkq.kicker.started', {})
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('data')
  })

  test('keeps a line on one row for errors, bigints, multi-line strings and cycles', () => {
    const { lines, log } = capture()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic

    log('WARN', 'wrkq.kicker.sweep_target_drive_failed', {
      error: new Error('first\nsecond'),
      seq: 2n ** 70n,
      text: 'a\nb',
      cyclic,
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]!.slice(0, -1)).not.toContain('\n')
    const { data } = JSON.parse(lines[0]!)
    expect(data.error).toMatchObject({ name: 'Error', message: 'first\nsecond' })
    expect(data.seq).toBe('1180591620717411303424')
    expect(data.text).toBe('a\nb')
    expect(data.cyclic).toEqual({ name: 'loop', self: '[Circular]' })
  })
})
