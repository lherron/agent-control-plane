# C2 threads

## Sub-features

The loopback thread routes create Lance-owned wrkq workstreams under `c2/threads`, read bodies and etags, edit with fences, open with continuation resume, and close with outcomes. A thread's own seat is named by its `acp/thread/seat` extension and has a W-id scope. Bookmarks use the independent HRC work register. A bounded sweep archives recorded own seats after idle time, protects running turns and lit attention, and retries archives for recently closed threads. Thread sends resume through Open rather than starting a fresh conversation.

- Surface: `route:GET /v1/c2/threads/:id @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/c2/threads/options @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:PATCH /v1/c2/threads/:id @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/c2/threads @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/c2/threads/:id/close @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/c2/threads/:id/open @ packages/acp-server/src/routing/param-routes.ts`

## How to get to it

Call ACP's `/v1/c2/threads` routes on loopback. An absent socket peer and a non-loopback peer are denied. The composer options read the existing ASP agent catalog and wrkq project registry, merging matching ACP admin presentation/default fields; bodies come from wrkq. Bookmark choices are running standing seats only: T-/W- scopes are excluded before work reads, and the HRC owner has no bounded enumeration of parked seats. The read never pages historical sessions. Write bodies carry `requestId`, and edits/close carry the `expectEtag` returned by Read. Instance c2 config exposes `threadIdleMs` (default four hours) and `threadSweepMs` (default ten minutes), populated from `ACP_C2_THREAD_IDLE_MS` and `ACP_C2_THREAD_SWEEP_MS`.

## Driving it

Owner-authorized real-seat acceptance is `~/praesidium/var/wrkq-artifacts/T-13298/run-acceptance.sh`. It uses an isolated ACP router on 18479, real wrkq/HRC, disposable cody seats, and a scratch Vesta/config so it does not become a second production card controller. Read its README before running. It creates real workstreams, starts real providers, sends bookmark mail, writes terminal notes to the project Mable, then retires the seats and archives its rows. The default shortened sweep applies to every recorded thread seat on this node, so run it only with the C2 owner's authority.

## Gotchas

Wrkq replay is separate from HRC's start/steer keys and the work etag. Later owner refusal never rolls back a created thread. Named outcomes distinguish `seat_record_refused`, `start_failed`, `work_refused`, `prompt_not_sent`, `seat_refused`, and `conflict`; uncertain starts are never reported started. Open never falls back to a fresh conversation for a seat that has run. Close keeps continuation, and its Mable note is recorded with `note`, which never presents or wakes a seat. Never run the acceptance's shortened sweep as a second production service. Installed ACP activation remains Mable's restart operation.

## Proven when

The rerunnable real-owner result demonstrates a W row and extension, workstream binding, first prompt with the thread line, steer during that turn, edit/conflict, protected attention/bookmarks, idle archive, remembered context after resume, recovery after a refused start, closed outcome, one terminal note without presentation, and cleanup. The isolated router proves source behavior against real installed owners. Claim installed ACP activation only after Mable restarts it and the live 18470 routes are smoked.
