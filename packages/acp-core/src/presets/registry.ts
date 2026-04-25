import { codeDefectFastlaneV1 } from './code_defect_fastlane.v1.js'
import { codeFeatureTddV1 } from './code_feature_tdd.v1.js'

import type { Preset } from '../models/preset.js'

function presetRegistryKey(presetId: string, version: number): string {
  return `${presetId}@${version}`
}

const presetRegistry = new Map<string, Preset>([
  [
    presetRegistryKey(codeDefectFastlaneV1.presetId, codeDefectFastlaneV1.version),
    codeDefectFastlaneV1,
  ],
  [presetRegistryKey(codeFeatureTddV1.presetId, codeFeatureTddV1.version), codeFeatureTddV1],
])

export function getPreset(presetId: string, version: number): Preset {
  const preset = presetRegistry.get(presetRegistryKey(presetId, version))
  if (preset === undefined) {
    throw new Error(`Unknown ACP preset: ${presetId}@${version}`)
  }

  return preset
}

export function listPresets(): Array<{ presetId: string; version: number }> {
  return Array.from(presetRegistry.values())
    .map((preset) => ({ presetId: preset.presetId, version: preset.version }))
    .sort((left, right) =>
      left.presetId === right.presetId
        ? left.version - right.version
        : left.presetId.localeCompare(right.presetId)
    )
}
