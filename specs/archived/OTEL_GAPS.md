# OTEL Gaps

Notes for continuing the HRC event investigation in a fresh session.

## Current Symptom

`hrc monitor watch cody@agent-spaces` can show user prompts and tool activity for interactive/tmux Codex runs, but may not show assistant LLM responses as semantic `turn.message` events.

Observed example:

- Main interactive scope: `agent:cody:project:agent-spaces`
- Transport: tmux / Ghostty surface
- Raw lifecycle/tool events were present.
- User prompts were present.
- Assistant response text was missing from semantic `turn.message` rows.
- Raw OTEL `response.output_text.*` rows inspected at the time did not appear to contain usable response text.

## What Was Ruled Out

- The `hrc monitor watch --json` renderer rewrite was not the production Discord failure.
- Production ACP/gateway code does not shell out to `hrc monitor watch`.
- `hrc monitor watch` displays assistant responses when `turn.message` rows exist.
- Headless Codex runs used through ACP/Discord can emit `turn.message`; verified by Discord e2e on 2026-04-21 with marker `ACP_E2E_OK_1511`.

## Likely Gap

The likely gap is in the Codex tmux/interactive event capture or OTEL normalization path:

- tmux Codex run emits enough events for prompts/tools/lifecycle.
- assistant text is not being converted into semantic `turn.message`.
- Need to confirm whether assistant text is absent from raw OTEL rows or present under a different event/attribute shape.

## Relevant Areas

Likely files/packages:

- `packages/hrc-events/src/otel-normalizer.ts`
- `packages/hrc-events/src/events.ts`
- `packages/hrc-server/src/launch/codex-otel.ts`
- `packages/hrc-server/src/hrc-event-helper.ts`
- `packages/hrc-server/src/launch/exec.ts`
- `packages/hrc-store-sqlite/src/repositories.ts`

Useful DB:

- `/Users/lherron/praesidium/var/state/hrc/state.sqlite`

Useful tables:

- `hrc_events`
- runtime/launch/run tables in the HRC state DB

## Suggested Next Checks

1. Reproduce with a fresh interactive/tmux Codex turn on `cody@agent-spaces`.
2. Capture the new `run_id` from `hrc_events`.
3. Dump all raw events for that run:

   ```bash
   sqlite3 /Users/lherron/praesidium/var/state/hrc/state.sqlite \
     "select hrc_seq, event_kind, category, substr(payload_json,1,1000) from hrc_events where run_id='<run_id>' order by hrc_seq;"
   ```

4. Search raw payloads for assistant content:

   ```bash
   sqlite3 /Users/lherron/praesidium/var/state/hrc/state.sqlite \
     "select hrc_seq, event_kind, payload_json from hrc_events where run_id='<run_id>' and payload_json like '%assistant%';"
   ```

5. Compare against a known-good headless Codex/ACP run, such as the Discord e2e run that produced `ACP_E2E_OK_1511`.
6. If assistant text exists in raw payloads, add/adjust normalizer mapping to emit `turn.message`.
7. If assistant text is absent from raw payloads, inspect `codex-otel` capture and the underlying Codex output stream for changed event names or attributes.

## Related Historical Context

Earlier Discord failure on 2026-04-21 was caused by ACP/gateway process issues, not `hrc monitor watch` rendering:

- Gateway could send a Discord "Processing" placeholder.
- ACP ingress either was not running or failed before launch/delivery.
- This was addressed by adding `acp server` as the combined process surface and by starting ACP + gateway together.

Remaining issue after that fix is specifically the interactive/tmux Codex assistant-output semantic event gap.
