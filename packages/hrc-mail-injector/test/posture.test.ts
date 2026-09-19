import { describe, expect, test } from 'bun:test'

import { assertMailInjectorPosture } from '../src/index.js'

describe('mail injector HRC ownership admission', () => {
  test('accepts bridge and deletion postures only', () => {
    expect(() => assertMailInjectorPosture('disabled')).not.toThrow()
    expect(() => assertMailInjectorPosture('absent')).not.toThrow()
  })

  test('refuses concurrent or malformed HRC delivery ownership', () => {
    expect(() => assertMailInjectorPosture('in-process')).toThrow(/in-process/)
    expect(() => assertMailInjectorPosture(undefined)).toThrow(/recognized/)
  })
})
