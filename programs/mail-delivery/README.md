# Mail delivery

A Python 3.14 port of `hrc-mail-injector`, hosted as kernel program
`mail-delivery` through `mail_delivery.main`. The `delivery_owner` row in the
injector database selects `injector` (the default when absent) or `port`.
Each process must hold an exclusive SQLite transaction on the dedicated
`hrc-mail-injector.deliverer-lock.sqlite` beside that database before starting
a controller. A flip waits for the previous controller to stop and close its
clients/store before releasing the lock. A hung or suspended holder prevents
handover until it resumes or exits; there is no timed bypass.

At startup, main reads the injector's installed launchd plist
(`~/Library/LaunchAgents/com.praesidium.hrc-mail-injector.plist`) and applies its
`HRC_` settings and `PATH` before constructing delivery paths or clients. The
flip command reads its database path from that same plist. A missing plist or
missing `HRC_WRKQ_DB` leaves the program shadowing, logs
`mail_delivery.node_config_missing` once, and admits no acting controller.
`MAIL_DELIVERY_INJECTOR_PLIST` selects a scratch plist for isolated acceptance;
production kernels leave it unset. Failed starts retry after 1, 2, 4 seconds,
up to 30; successful start or an observed owner change resets the backoff.
Shadow watches close before acting and rebuild from fresh views on stand-down.

Local-node operator commands (installation and cutover require the node's
authorized rollout; these commands change installed behavior):

```sh
just test-mail-delivery
just install-mail-delivery
just mail-delivery-owner           # desired owner and observational reporting
just mail-delivery-owner port      # wait up to 30 seconds for handover
just mail-delivery-owner injector  # reverse handover
just uninstall-mail-delivery
```

On a satellite node with no current ACP checkout (hrcdev, svc), run these from
max3's checkout instead; `host` is the ssh name (`hrcdev`, `mini` for svc):

```sh
just install-mail-delivery-on <host>          # stage committed sources there, run the installer
just mail-delivery-owner-on <host>            # print that node's owner row
just mail-delivery-owner-on <host> port       # flip that node; `injector` reverses
```

The installer copies `module.json` and `mail_delivery/*.py` into
`~/.local/lib/praesidium-kernel/modules/mail-delivery/`, rejecting symlinks,
and removes the pre-rename `programs/mail-delivery/` tree if one is there.
It generates `wrkq_pin.py` from ACP's installed `@wrkq/client` and
`build_info.py` from the installed ACP commit. It stages the complete tree
and renames it into place. The kernel replaces it after two stable scans;
no daemon restart is needed. The old `-shadow` recipe names remain aliases.
The installer neither reads nor flips the flag. With owner `injector`, the
program observes in shadow mode and the injector continues delivering.

`mail_injector.started` reports process health (`status: running`) and a
`delivering` boolean. Each new TypeScript controller emits another anchor for
shadow replay; `mail_injector.mode` records `delivering` or `standing_by`.
Python mode changes use `mail_delivery.mode` (`acting` or `shadow`). The three
`delivering_*` columns report status; the lock grants delivery authority.
The sole decision that reads reporting is the operator's flip to `port`: it
requires a reported `injector` with a live PID, proving a flag-following
injector has been deployed. Otherwise it refuses before writing and asks for
that deployment first. Rollback to `injector` is always allowed; there is no
force option. Deliverers never use reporting to grant admission.

Flag reads use read-only connections, create neither database nor table, and
treat a missing table or row as `injector`. During SQLite contention they keep
the last known owner. Only a flip or reporting after lock acquisition creates
the table; installing the shadow alongside a legacy injector leaves it absent.
When kernel EOF sets `program.stopping`, main finishes the controller stop,
clears reporting, and returns to the shell, retaining the lock until process
exit. An unfinished stop is cut off by the shell's five-second grace; restart
uses the same open-intent reconciliation as the injector.

In shadow mode, the existing observation and scoring behavior is preserved:

The kernel pins the interpreter and supplies program identity/configuration.
`Client(program)` watches `room.mail`, `seat` and `runtime`; each reset replaces
the corresponding view. Owner detail/task reads go through that read-only
client, using explicit selectors. In shadow mode no `pendingView` call is made: it re-pends
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
  --program-commit 81a6853246541f514432aff41ec6c51a62c06270 \
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

[mail-delivery-port-policy.md](../../architecture/contracts/mail-delivery-port-policy.md) records the source rules and historical qualifications.
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

The gate distinguishes the installed program revision from the operator scorer
revision. Fix/re-run the scorer from this canonical checkout without replacing
the running program. Every written report requires both
`installed_program_commit` and `scorer_source_commit`; Markdown prints both.
The CLI requires `--program-commit`, derives its own checkout commit (or accepts
`--scorer-commit`), and runs the fixed real-record regressions before reading
live evidence. API/monitor callers must run
`python3 -m unittest tests.test_live_score_regression` before using a changed
scorer. Versioned inputs preserve the accepted hour's two known agreements, six
cache defects, and EN-50888's drive-phase boundary. No installed-program restart
is required by an operator scorer change.

EN-50915: a missing cached home reply may use the ordinary allowlisted
`GET /v1/federation/locate`. Comparisons label `home_source` as
`cached_before_admission` or `read_after_admission`, retain the reply's binding
time and whether it proves the binding predates admission, and report counts
beside capability sources. Binding changes immediately after admission are
outside this comparison's supported model. Reconstruction never calls
`POST /v1/submissions/preempt/admission`; dependent hold decisions name that gap.

A seat watch ready before the intent, with no scope entry as of that time,
proves absence and permits the launch comparison. Only an unready watch without
a prior entry is `history_cold`. Snapshot resets record their receipt time;
positive as-of entries retain their own source and receipt clocks.

Use `--preview --since <UTC-start> --until <UTC-end>` for a bounded preview
that can span midnight. Its new cohort is created within that interval. Daily
reports retain their UTC-day cohort. Injector evidence is bounded by the report
cutoff, so later admissions cannot inflate an earlier delivered count; daily
reports may still use the following day's evidence when scoring after midnight.

Scorer re-runs of the same `since`/`until` window preserve the superseded JSON
and Markdown beside the new report. The header records both scorer commits,
the change, every moved envelope class, departures from `differed_defect`, and
headline changes; an unchanged result says so. `--previous-score <JSON>`
compares a separately named earlier report; `--scorer-change` supplies the
one-line explanation (otherwise the scorer commit subject is used).

EN-50930/50935: when no usable capability probe exists, reconstruction may
read the ordinary allowlisted runtime seat route, labelled
`port_probe_after_admission`. It checks runtime and generation, then proves
that invocation was active at admission using as-of history or an earlier
ordinary runtime read. For a cold invocation only, the existing anonymous
broker-event GET from seq zero may prove it existed before admission; the
comparison records the proving seq/time. No consumer or cursor is declared.
A different invocation or missing pre-admission proof remains
`first_delivery.invocation_at_admission`; runtime replacement remains explicit.
The later probe supplies only frozen invocation capabilities, never past seat
state. Null later classes stay unknown.

State-end timestamps from wrkq can have only whole-second precision. The scorer
includes that final second, while explicit fractional-second boundaries remain
strict; otherwise a matching injector intent can be incorrectly excluded. Real
record EN-50982 is retained in the fixed scorer preflight beside the accepted
hour and EN-50888 phase cases. Explicit presentation receipts still bound the
pending state.
