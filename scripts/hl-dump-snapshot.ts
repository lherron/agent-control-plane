import { writeFileSync } from 'node:fs'
import { openAcpStateStore } from 'acp-state-store'
const dbPath = process.env.ACP_STATE_DB ?? '/Users/lherron/praesidium/var/db/acp-state.db'
const out = process.argv[2] ?? '/tmp/acp-snapshot.json'
const store = openAcpStateStore({ dbPath })
const snap = store.workflowRuntime.loadSnapshot()
writeFileSync(out, JSON.stringify(snap, null, 2))
console.log(
  `wrote ${out} (events=${snap.events.length}, tasks=${snap.tasks.length}, maps=${snap.workflowHrcRunMaps?.length ?? 0})`
)
