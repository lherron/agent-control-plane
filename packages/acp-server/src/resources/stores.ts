import { type InterfaceStore, openInterfaceStore } from 'acp-interface-store'
import { type JobsStore, openSqliteJobsStore } from 'acp-jobs-store'

type StorePaths = {
  jobsDbPath: string
  interfaceDbPath: string
}

type StoreCacheEntry =
  | { type: 'jobs'; store: JobsStore }
  | { type: 'interface'; store: InterfaceStore }

const storeCache = new Map<string, StoreCacheEntry>()

// Reusing the same apply input object reuses its in-memory stores on retry.
let activeMemoryApplyInput: StorePaths | undefined

export function openCachedJobsStore(dbPath: string): JobsStore {
  const key = `jobs::${dbPath}`
  const cached = storeCache.get(key)
  if (cached?.type === 'jobs') {
    return cached.store
  }
  const store = openSqliteJobsStore({ dbPath })
  storeCache.set(key, { type: 'jobs', store })
  return store
}

export function openCachedInterfaceStore(dbPath: string): InterfaceStore {
  const key = `iface::${dbPath}`
  const cached = storeCache.get(key)
  if (cached?.type === 'interface') {
    return cached.store
  }
  const store = openInterfaceStore({ dbPath })
  storeCache.set(key, { type: 'interface', store })
  return store
}

function evictCachedStore(type: 'jobs' | 'iface', dbPath: string): void {
  const key = `${type}::${dbPath}`
  const cached = storeCache.get(key)
  cached?.store.close()
  storeCache.delete(key)
}

export function prepareMemoryStoresForApply(input: StorePaths): void {
  if (input.jobsDbPath !== ':memory:' && input.interfaceDbPath !== ':memory:') {
    return
  }
  if (activeMemoryApplyInput === input) {
    return
  }
  if (input.jobsDbPath === ':memory:') {
    evictCachedStore('jobs', input.jobsDbPath)
  }
  if (input.interfaceDbPath === ':memory:') {
    evictCachedStore('iface', input.interfaceDbPath)
  }
  activeMemoryApplyInput = input
}

export function discardApplyStores(input: StorePaths): void {
  evictCachedStore('jobs', input.jobsDbPath)
  evictCachedStore('iface', input.interfaceDbPath)
  if (activeMemoryApplyInput === input) {
    activeMemoryApplyInput = undefined
  }
}
