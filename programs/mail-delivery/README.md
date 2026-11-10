# Mail delivery shadow

A Python 3.14 standard-library port of the injector decision policy, hosted as
kernel program `mail-delivery`. This step only observes and logs; it never
submits, starts, presents, fails, defers, withdraws or declares a subscriber.

From the canonical ACP checkout, on the local node:

```sh
just test-mail-delivery
just install-mail-delivery-shadow
prae node get max3
```

The installer copies only `program.json` and `mail_delivery/*.py` into
`~/.local/lib/praesidium-kernel/programs/mail-delivery/`, rejecting symlinks.
It stages a complete tree and renames it into place. The kernel starts or
replaces it after two stable scans; no service restart is needed.
`just uninstall-mail-delivery-shadow` removes that local tree. Neither recipe
contacts another node. T-13270 authorizes installation on max3 only.

The kernel pins the interpreter and supplies program identity/configuration.
`Client(program)` watches `room.mail`, `seat` and `runtime`; each reset replaces
the corresponding view. Owner detail/task reads go through that read-only
client, using explicit selectors. No `pendingView` call is made: it re-pends
wrkq deferrals. Scope-less interface mail belongs to ACP gateways and is
excluded from agent-seat decisions.

The adapter reads the injector's existing SQLite store with `mode=ro` and
`query_only=ON`, closes each short batch transaction before network I/O, and
never uses `immutable`. HRC reads use its Unix socket, caller label
`mail-delivery-shadow`, and an exact method/path allowlist in `hrc_read.py`.
The only POST reads are runtime inspect, declaration resolve, and the explicitly
authorized `/v1/submissions/preempt/admission`; every submission door is refused
locally. Anonymous broker replay uses runtime, invocation and generation fences,
without subscriber declarations or receipts. The injector's `mail` consumer
is never used.

`Memos` is one reducer with two feeders: `InjectorLogFeeder` replays existing
injector outcomes for shadow comparison; `OwnOutcomeFeeder` is the same entry
for future acting-port outcomes. Replay anchors at the injector's latest
`mail_injector.started`, and re-anchors at a subsequent start. A missing anchor
or unlogged required fact remains unknown. Partial log lines wait for the next
poll. Broker movement clears quiet holds according to the existing injector
rules. Everything can be reconstructed after a shadow restart.

Decisions are deduplicated by envelope observation, normalized policy inputs,
seat state and crossed policy deadlines. Tool previews/activity timestamps do
not create new decisions. The loop checks new log outcomes each second, runs
30-second reminder/evidence sweeps (also within the 300-second recovery bound),
and uses only kernel waits while idle. Logs are flushed through `client.log` to
`~/praesidium/var/logs/agent-control-plane/mail-delivery.log`. Each decision
includes state/state-transition time, target, broker state, action/reason,
missing input if any, creation/decision times and log-memo/movement provenance.

Run the operator report from `programs/mail-delivery`:

```sh
python3 -m mail_delivery.score \
  --injector-db "$HOME/praesidium/var/state/acp/hrc-mail-injector.sqlite" \
  --day 2026-11-10 \
  --out "$HOME/praesidium/var/wrkq-artifacts/T-13270"
```

Shadow and injector log paths default to their installed locations. Optional
`--since` and `--until` ISO timestamps select a bounded acceptance interval.
Output is `score-YYYY-MM-DD.md` plus JSON, one pair per UTC day. Only the report
directory is written. The scorer joins both latest-per-envelope SQLite evidence
tables and injector log drives/phases/intents/hold/skip/seat-not-ready records.
It retains every observation, comparison and selected raw evidence line.

A live row requires evidence after its observed state-transition time, before
the next known transition. Explicit-envelope evidence must be within 300 s of
the shadow observation; target-only evidence within 30 s. Presented mail cannot
match an old full-body admission, and intent/reminder holds cannot match a
previous delivery door. An unmatched act is a defect once its evidence window
closes; an unmatched hold/defer agrees by inaction if no injector act occurred.
Only a still-open window is `pending_evidence`, with its cause retained.
Inaction windows also end at the next changed observation or a retry deadline.
Inaction agreement is reported separately from compared door agreement. Unmapped injector evidence is separated from a
`shadow_input_gap` beneath `cannot_decide`; only the latter is a port defect.
Every bucket separates today's new envelopes from older backlog; the gate is
judged on new traffic. Timing flags a shadow decision at least 60 s before the
injector, without asserting that the injector missed an insert. Read-triggered
wrkq maintenance attributed to `agent:mail-delivery` is excluded, not counted as
a shadow write.

`decide(envelope, seat, runtime, now)` remains pure. `None` means unknown;
explicit `status='none'` / `kind='none'` confirms absence. `Decision.effects`
describes work but performs none. No intentional policy changes are enabled.
Explicitly stamped flat fixture logs remain readable for T-13192 scoring tests; they lack
state boundaries and are not evidence for installed live agreement.

[POLICY.md](POLICY.md) records the source rules and historical qualifications.
Live acceptance and first-hour score evidence are in the T-13270 artifact dir.
Python tests remain opt-in, outside the repository's `just verify` gate.

First-delivery comparisons run the same `decide()` against facts already read,
with this envelope's own intent/presentations excluded and the seat/runtime
from the injector's diagnostic. Historical status, memo anchors and invocation
identity must be provable; gaps are named rather than inferred from the door.
The port's matching invocation probe supplies capability when available; the
injector log is an explicitly labelled fallback. Both derivations are compared
when present. A capability disagreement is a defect. The scorer recovers the
injector's door from joined envelope/runtime intent and admission log lines.

Each envelope retains all observation scores and the observation setting its
class. Any defect dominates; first-delivery or shadow input gaps follow, then
open evidence windows. Agreement requires a first-delivery or real first action
comparison; inaction alone cannot establish a door match. Daily headers show
new delivered, compared-and-agreed, uncompared count/share and named causes,
plus capability-source counts. The report never awards a gate verdict.

First-delivery work is triggered by matched injector intent/admission evidence,
including envelopes already presented or acked. A separate
`shadow.first_delivery` event joins the ordinary observations in the scorer;
it is never scored as another as-observed action. Existing envelope detail and
store reads move with that trigger; it adds no HRC route or probe.

The watch history retains at most 20 payload changes per seat/runtime key.
Each entry records receipt time and the payload's own change time when present;
as-of selection requires both not to follow the intent. Removed/reset rows
leave tombstones, so a deleted row cannot supply a later state. Inactive keys,
recent envelope details and existing HRC probe evidence expire after 15 minutes.
Histories remain in memory; logs include only selected facts and clocks.
A missing pre-admission seat/runtime entry is named, as is missing invocation
capability proof. The diagnostic supplies the injector's physical seat state,
labelled separately from watch runtime status; an explicit intent-seat fallback
is labelled too. No capability is derived from a door.

Injector completions belong to the state in which their drive began, including
a drive whose completion straddles wrkq's second-resolution presentation time.
