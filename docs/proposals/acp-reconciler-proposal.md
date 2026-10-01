# ACP reconciler MVP

**Proposed, not approved or submitted to Daedalus.** Refined by Cody and Mable
as peers on October 1, 2026, following Lance's request to simplify the MVP.

A small loop makes explicitly requested subtasks run when their inputs are
available, using the task and dispatch systems we already have.

**Request → wait until ready → run → write output and complete.**

A `request-diagram-preview` skill creates two named subtasks under an owner:
`T-12345.diagram` and `T-12345.preview`. The brief is the subtask description.
Each request is one object in existing task metadata:

```json
{
  "acp": {
    "request": {
      "capability": "render-preview",
      "rev": 1,
      "inputs": ["T-12345.diagram"],
      "output": "docs/diagrams/example.png",
      "notify": "mable@agent-control-plane:primary"
    }
  }
}
```

`diagram` omits inputs and names an `.arris.json` output. The skill writes complete
requests; ordinary subtasks stay passive. Capability bindings are two fixed
entries: `diagram` targets the Arris specialist's subtask seat;
`render-preview` invokes a bounded Arris renderer. No catalog is needed yet.

Run one `acp-reconciler` inside `acp-server` on one designated node. It scans
requested subtasks on startup and every 30–60 seconds, with no controller database,
event cursor or durable queue. Each scan reads current wrkq state:

```text
for each open requested subtask:
    skip archived/deleted owners and claimed work
    wait unless every input is completed and its output file exists
    wait if the configured concurrency limit is reached
    dispatch the agent or claim and run the renderer
```

Wrkq remains the work/claim authority, wrkc delivers messages, and HRC places agent
seats. A dry-run of the same checks explains waiting; checks create no model turns
or wait-reason comments. Existing claims and pending keyed sends count toward the
small concurrency limit, including after restart.

Agent dispatch uses `recon:<subtaskId>:<rev>:<executorScope>` as its wrkc idempotency
key. Its specific duplicate-key error means already dispatched; other send errors
remain visible. Both executors claim before work and skip completed or already
claimed requests, even claims under their own scope. The worker writes and checks
the requested output, then completes its own subtask. Manual push uses that same
convention; duplicate prevention for agent side effects depends on following it.

The worker sends a final `--fyi` reply to the controller, clearing its own reply
obligation without creating one for the controller, then a separate `--fyi` to
`notify`. The renderer claims under the controller's principal with task scope
`acp-reconciler@<project>:<subtaskId>`, runs with a timeout, writes a temporary PNG,
renames it onto the declared output, completes and notifies. It needs no model seat,
capability-host operation or flow engine.

The MVP trusts existing wrkq writers. Capability selection is allowlisted; resolved
input and output paths must stay under the owner's project repo and use the
capability's expected extensions. Results are recorded on the subtask with their
paths. The renderer consumes the completed producer's declared file, so a
cancelled producer does not unlock it. The pilot requires those repo files to be
accessible on the renderer node; automatic remote artifact transfer is deferred.

Failed dispatches and dead claims need manual recovery. The scan never retries
with a new key or takes over a claim on its own. A rerun bumps `rev` and reopens
the subtask; a stranded claim must first be released after checking the old worker.
Cancelling stops new dispatch; existing runtime controls stop in-flight work.
Owner completion leaves its subtasks intact. Edits alone do not rerun completed work.

Propose **diagram → preview** as the first pilot: request through the skill,
produce an editable Arris document, then render its PNG without another model.
The earlier hook-duration experiment can follow; Lance has not selected a pilot.
Verify both outputs on real installed surfaces, restart without redispatch,
repeat a manual push without repeating work, and check that a second controller
copy or missing/cancelled input causes no duplicate execution. Show a stalled
worker remains visible for manual recovery. Waiting adds at most one scan interval.

This MVP adds the request skill/helper, the small loop and the renderer. Review,
when wanted, is another ordinary subtask. It adds no attempt or acceptance service,
new task states, artifact store, automatic retry/failover, standing-goal settling
or graph UI.

Diagrams: [system view](acp-reconciler-design/architecture.png)
([editable](acp-reconciler-design/architecture.arris.json)) and
[flow](acp-reconciler-design/protocol.png)
([editable](acp-reconciler-design/protocol.arris.json)). Earlier design discussion
is retained in Git history and wrkc room R-00241. This revision authorizes no
implementation or service changes.
