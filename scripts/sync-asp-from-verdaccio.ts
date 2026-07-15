import { type SyncSpec, runVerdaccioSyncCli } from './lib/verdaccio-sync'

// ASP and HRC publish as two independent dev-timestamp streams (ASP 0.1.1-dev.*,
// HRC 0.1.0-dev.*), each internally coherent. @wrkq/client is a third stream and
// is synced separately by sync-wrkq-from-verdaccio.ts.
export const aspSyncSpec: SyncSpec = {
  label: 'ASP',
  lockName: '.asp-sync.lock',
  groups: [
    {
      label: 'ASP',
      packages: [
        'agent-scope',
        'cli-kit',
        'spaces-config',
        'spaces-runtime',
        'spaces-execution',
        'spaces-harness-claude',
        'spaces-harness-codex',
        'spaces-harness-pi',
        'spaces-harness-pi-sdk',
        'agent-spaces',
      ],
    },
    {
      label: 'HRC',
      packages: [
        'agent-action-render',
        'hrc-core',
        'hrc-sdk',
        'hrc-frame-render',
        'hrc-events',
        'hrc-store-sqlite',
        'hrc-server',
      ],
    },
  ],
}

if (import.meta.main) await runVerdaccioSyncCli(aspSyncSpec)
