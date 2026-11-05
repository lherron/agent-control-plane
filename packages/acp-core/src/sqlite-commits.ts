/** Observe writes through a store's database, publishing only after outer commit.
 * Install after migrations and before preparing repository statements. */
export function observeSqliteCommits<T extends object>(
  database: T,
  onCommit?: (tables: ReadonlySet<string>) => void
): T {
  if (onCommit === undefined) return database
  let depth = 0
  let dirty = new Set<string>()
  function changed(table: string): void {
    if (depth > 0) dirty.add(table)
    else onCommit?.(new Set([table]))
  }
  function transactionCall(call: () => unknown): unknown {
    const previous = new Set(dirty)
    depth++
    let succeeded = false
    try {
      const result = call()
      succeeded = true
      return result
    } finally {
      depth--
      if (!succeeded) dirty = previous
      if (depth === 0 && dirty.size > 0) {
        const committed = dirty
        dirty = new Set()
        onCommit?.(committed)
      }
    }
  }
  return new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'transaction') {
        return (...args: unknown[]) => {
          const transaction = Reflect.apply(value, target, args) as (...args: unknown[]) => unknown
          return new Proxy(transaction, {
            apply(fn, self, params) {
              return transactionCall(() => Reflect.apply(fn, self, params))
            },
            get(fn, property) {
              const method = Reflect.get(fn, property)
              if (typeof method !== 'function') return method
              return (...params: unknown[]) =>
                transactionCall(() => Reflect.apply(method, fn, params))
            },
          })
        }
      }
      if (key === 'prepare' || key === 'query') {
        return (source: string, ...args: unknown[]) => {
          const statement = Reflect.apply(value, target, [source, ...args]) as object
          const mutation =
            /^\s*(?:(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`\[]?(\w+)/i.exec(
              source
            )
          const writes = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(source)
          const table = mutation?.[1]?.toLowerCase() ?? '*'
          return new Proxy(statement, {
            get(stmt, method) {
              const fn = Reflect.get(stmt, method, stmt)
              if (typeof fn !== 'function') return fn
              return (...params: unknown[]) => {
                const result = Reflect.apply(fn, stmt, params)
                if (writes && (method === 'run' || method === 'get' || method === 'all')) {
                  const hasChanges =
                    method === 'run'
                      ? (result as { changes: number }).changes > 0
                      : method === 'all'
                        ? (result as unknown[]).length > 0
                        : result != null
                  if (hasChanges) changed(table)
                }
                return result
              }
            },
          })
        }
      }
      return value.bind(target)
    },
  })
}
