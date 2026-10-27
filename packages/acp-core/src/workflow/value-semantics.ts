import { stripUndefinedKeys } from '../internal/canonical-json.js'
import { deepFreezeValue } from '../internal/deep-freeze.js'

export function clone<T>(value: T): T {
  return structuredClone(stripUndefinedKeys(value))
}

export const deepFreeze = <T>(value: T): T => {
  deepFreezeValue(value)
  return value
}
