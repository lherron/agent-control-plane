import { describe, expect, test } from 'bun:test'

import { runWlearnCli } from '../cli.js'

describe('wlearn cli', () => {
  test('unknown commands fail instead of owning workflow lifecycle state', () => {
    expect(() => runWlearnCli(['promotion', 'promote'])).toThrow('unknown wlearn command')
  })
})
