import { syncFromVerdaccio } from './lib/verdaccio-sync'

// @wrkq/client is its own dev-timestamp stream (0.1.0-dev.*), independent of the
// ASP/HRC streams synced by sync-asp-from-verdaccio.ts.
await syncFromVerdaccio({
  label: 'WRKQ',
  lockName: '.wrkq-sync.lock',
  groups: [{ label: 'WRKQ', packages: ['@wrkq/client'] }],
})
