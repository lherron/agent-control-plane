# Mail delivery shadow policy

Python 3.14, standard library only. Importable policy and scoring modules; no
service entry point, client, private store, scheduler, or delivery operations.
The kernel will pin the interpreter and own program lifecycle in a later task.

Run tests from the ACP checkout:

```sh
just test-mail-delivery
```

This runs `cd programs/mail-delivery && python3 -m unittest`. It is deliberately
outside `just verify`. To select Python 3.14 explicitly, run
`python3.14 -m unittest` from this directory.

Run the operator scoring tool from this directory:

```sh
python3 -m mail_delivery.score \
  --shadow-log /path/to/shadow.jsonl \
  --injector-db "$HOME/praesidium/var/state/acp/hrc-mail-injector.sqlite" \
  --day 2026-11-10 --out /path/to/report
```

Outputs are `<day>.md` and `<day>.json`. Day boundaries are UTC. SQLite uses
`mode=ro`, `query_only=ON`, parameterized envelope lookups, and one read
transaction across both evidence tables. A missing database is never created.
Only the requested output directory is written.

`mail_delivery.decision.decide(envelope, seat, runtime, now)` accepts frozen
plain dataclasses. All policy timestamps and `now` are epoch milliseconds.
`None` means an unknown fact; explicit records with `status='none'` or
`kind='none'` mean confirmed absence. Relevant missing facts produce
`cannot_decide` and a dotted `missing_fact`. Inputs are normalized observations:
`state='terminal'` means the owner confirmed terminality; `runtime_live` refers
to the presentation receipt's runtime; `runtime_matches` compares the latest
receipt to that presentation, not necessarily the currently selected seat.
No adapter or owner reads are implemented here. `Decision.form` distinguishes
full body, defer-retry pointer, reminder, and digest member. Digest members
must later be grouped into one submission per target. `Decision.effects` names
auxiliary work such as arm_reminder, withdraw, stalled logging, or preserving
TTL uncertainty; it performs no work. Hold/defer can therefore represent
reconciliation without adding unsupported delivery doors.

Shadow log format (one observation per line):

```json
{"envelope_id":"EN-123","appeared_at":"2026-11-10T12:00:00Z","decided_at":"2026-11-10T12:00:01Z","decision":{"action":"steer","reason":"steer_capable"}}
```

Timestamps require a timezone. A `cannot_decide` decision must include
`missing_fact`. A disagreement is a defect unless its observation explicitly
includes `difference: {"kind":"design","reason":"approved-change-id"}` or
`difference: {"kind":"missing_data","field":"seat.steer_capable"}`. Those
annotations are explanations supplied by the caller/operator, not inferred by
the scorer. No design changes are enabled by this package. Synthetic logs
should carry `fixture: true` so the JSON retains that provenance.

The summary classifies the latest shadow observation of each envelope that day.
The injector tables contain only their latest row per envelope, not history.
The scorer retains every shadow observation in shadow_history and both injector rows, and selects the timestamp closest to the shadow
decision. `admitted` needs a same-runtime intent to identify the door. Birth
`invoke` and `launch` both map to `launch`. Unknown values are reported, never
inferred from their names. Timing is relative to the shadow's `appeared_at`;
negative durations and evidence outside the selected day remain visible for
investigation. The report cannot prove historical agreement after injector
rows have been overwritten.

[Policy notes](POLICY.md) list the first missing-field draft, code/brief
reconciliations, and scoring evidence limits. Acceptance evidence for T-13192
is in `~/praesidium/var/wrkq-artifacts/T-13192/`: red test runs, a repeatable
read-only acceptance script, its explicitly synthetic shadow log, and reports
joined to real max3 rows. There is no installed service to activate in this step.
