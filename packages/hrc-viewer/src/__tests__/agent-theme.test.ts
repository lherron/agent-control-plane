import { describe, expect, it } from 'bun:test'

import { agentTheme, contrastForeground, sessionTheme, terminalTint } from '../agent-theme.js'

const HEX = /^#[0-9a-f]{6}$/i

function luminance(hex: string): number {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

describe('agentTheme', () => {
  it('uses the deterministic hash for every agent id', () => {
    expect(agentTheme('cody').bg).toBe('#8b36a1')
    expect(agentTheme('some-random-agent')).toEqual(agentTheme('some-random-agent'))
    expect(agentTheme('some-random-agent').bg).toMatch(HEX)
  })

  it('normalizes agent ids before hashing', () => {
    expect(agentTheme('  CODY ')).toEqual(agentTheme('cody'))
  })

  it('gives different unlisted agents different colors', () => {
    expect(agentTheme('alpha').bg).not.toBe(agentTheme('beta').bg)
  })

  it('switches the foreground by luminance', () => {
    expect(contrastForeground('#000000')).toBe('#F2EEE6') // dark bg → light fg
    expect(contrastForeground('#FFFFFF')).toBe('#15110C') // light bg → dark fg
  })

  it('derives the terminal tint deterministically for unlisted agents', () => {
    expect(agentTheme('mystery').terminalBg).toBe(agentTheme('mystery').terminalBg)
    expect(agentTheme('mystery').terminalBg).toMatch(HEX)
    expect(luminance(agentTheme('mystery').terminalBg)).toBeLessThan(0.06)
  })

  it('keeps the hue when forcing a color into the dark tint band', () => {
    // a saturated red stays reddish (R dominant) after darkening
    const tint = terminalTint('#FF0000')
    const n = tint.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
  })
})

describe('per-session appearance', () => {
  it('uses all appearance keys from session metadata', () => {
    expect(
      sessionTheme(
        { agentId: 'cody' },
        {
          appearance: {
            color: '#1F7A78',
            terminalBg: '#123635',
            terminalFg: '#ABCDEF',
          },
        }
      )
    ).toEqual({ bg: '#1F7A78', terminalBg: '#123635', fg: '#ABCDEF' })
  })

  it('uses identity.agentId for rows without appearance metadata', () => {
    expect(sessionTheme({ agentId: 'cody' })).toEqual(agentTheme('cody'))
    expect(sessionTheme({ agentId: 'cody' }, { appearance: null })).toEqual(agentTheme('cody'))
  })

  it('resolves each key independently and computes contrast from the resolved color', () => {
    const identity = { agentId: 'cody' }
    const metadata = { appearance: { color: '#FFFFFF' } }
    expect(sessionTheme(identity, metadata)).toEqual({
      bg: '#FFFFFF',
      fg: contrastForeground('#FFFFFF'),
      terminalBg: agentTheme('cody').terminalBg,
    })
    expect(sessionTheme(identity, { appearance: { terminalBg: '#112233' } })).toEqual({
      ...agentTheme('cody'),
      terminalBg: '#112233',
    })
    expect(sessionTheme(identity, { appearance: { terminalFg: '#ABCDEF' } }).fg).toBe('#ABCDEF')
    expect(sessionTheme(undefined)).toEqual(agentTheme('unknown'))
  })
})
