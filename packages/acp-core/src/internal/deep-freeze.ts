export function deepFreezeValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>()
): void {
  if (value === null || typeof value !== 'object') {
    return
  }

  if (seen.has(value)) {
    return
  }

  seen.add(value)

  for (const nestedValue of Object.values(value)) {
    deepFreezeValue(nestedValue, seen)
  }

  Object.freeze(value)
}
