import { describe, expect, test } from 'bun:test'

import {
  codeDefectFastlaneV1,
  findTransitionPolicyRule,
  getPreset,
  listPresets,
} from '../src/index.js'

describe('acp-core presets', () => {
  test('registry returns the code_defect_fastlane v1 preset', () => {
    const preset = getPreset('code_defect_fastlane', 1)

    expect(preset).toBe(codeDefectFastlaneV1)
    expect(listPresets()).toEqual([{ presetId: 'code_defect_fastlane', version: 1 }])
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
})
