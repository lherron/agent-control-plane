import { describe, expect, test } from 'bun:test'

import {
  codeDefectFastlaneV1,
  codeFeatureTddV1,
  findTransitionPolicyRule,
  getPreset,
  listPresets,
} from '../src/index.js'

describe('acp-core presets', () => {
  test('registry returns shipped v1 presets', () => {
    const fastlanePreset = getPreset('code_defect_fastlane', 1)
    const featurePreset = getPreset('code_feature_tdd', 1)

    expect(fastlanePreset).toBe(codeDefectFastlaneV1)
    expect(featurePreset).toBe(codeFeatureTddV1)
    expect(listPresets()).toEqual([
      { presetId: 'code_defect_fastlane', version: 1 },
      { presetId: 'code_feature_tdd', version: 1 },
    ])
  })

  test('green -> verified parameterizes on risk class', () => {
    const preset = getPreset('code_defect_fastlane', 1)

    const lowRiskRule = findTransitionPolicyRule(preset, 'green', 'verified', 'low')
    const mediumRiskRule = findTransitionPolicyRule(preset, 'green', 'verified', 'medium')

    expect(lowRiskRule?.allowedRoles).toEqual(['tester', 'implementer'])
    expect(lowRiskRule?.disallowSameAgentAsRoles).toEqual([])
    expect(mediumRiskRule?.allowedRoles).toEqual(['tester'])
    expect(mediumRiskRule?.disallowSameAgentAsRoles).toEqual(['implementer'])
  })

  test('preset object is deeply frozen', () => {
    const preset = getPreset('code_defect_fastlane', 1)

    expect(Object.isFrozen(preset)).toBe(true)
    expect(Object.isFrozen(preset.transitionPolicy)).toBe(true)
    expect(Object.isFrozen(preset.guidance.red.doneWhen)).toBe(true)
    expect(() => {
      ;(preset.phaseGraph as string[]).push('oops')
    }).toThrow()
  })

  test('code_feature_tdd phase graph contains only real phases', () => {
    const preset = getPreset('code_feature_tdd', 1)

    expect(preset.kind).toBe('code_change')
    expect(preset.defaultRoles).toEqual(['owner', 'implementer', 'tester'])
    expect(preset.phaseGraph).toEqual([
      'scoped',
      'ready',
      'red',
      'green',
      'refactor',
      'tested',
      'accepted',
      'released',
    ])
    expect(preset.phaseGraph).not.toContain('open')
    expect(preset.phaseGraph).not.toContain('completed')
  })
})
