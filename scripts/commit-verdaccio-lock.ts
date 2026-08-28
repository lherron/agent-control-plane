import { commitSyncedLockfile } from './lib/verdaccio-sync'
import { wrkqSyncSpec } from './sync-wrkq-from-verdaccio'

await commitSyncedLockfile(wrkqSyncSpec.groups)
