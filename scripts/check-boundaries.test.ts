import { describe, expect, test } from 'bun:test'

import { findHrcViewerSdkViolations } from './check-boundaries.ts'

describe('hrc-viewer SDK boundary', () => {
  test('uses only the side-effect-free HRC SDK allowlist', async () => {
    expect(await findHrcViewerSdkViolations()).toEqual([])
  })
})
