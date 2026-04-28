# Discord Image Bidirectional — Implementation Status

**Spec:** `~/praesidium/acp-spec/spec/orchestration/API.md` (outbound-attachments), `CLI.md`, `HRC_DETAIL.md`, `AGENT_SPACES.md`, `IMPLEMENTATION_ACTUALS.md`, `SESSION_EVENTS.md`.
**Scope:** Bidirectional image support for the Discord gateway (T-01237..T-01253 + spec edits).
**State:** ✅ Functional end-to-end (live virtu round-trip verified). ⚠️ Code not committed; one task closure outstanding; a few v2 follow-ups identified.

## Final delivery (2026-04-25)

| ID | Phase | Owner | Result |
|---|---|---|---|
| T-01237 | Phase 1 — media contract | cody | `AttachmentRef` shape + threading through ACP/runtime/dispatch |
| T-01238 | Phase 2 — ACP materialization | larry | URL→local-file resolver in `packages/acp-server/src/attachments.ts` |
| T-01239 | Phase 3 — Discord ingress | cody | `attachment-ingress.ts` mapper; `app.ts` POSTs attachments + placeholder |
| T-01240 | Phase 4 — Discord egress | curly | `discord-render.ts` + `app.ts` extract image/media_ref → Discord files |
| T-01241 | Phase 5 — validation | smokey | 5 cross-phase tests; full repo validation |
| T-01246 | Defect — image not reaching codex | clod | 5-file fix threading attachments → `codex exec -i <path>` |
| T-01247 | Egress proposal review (against ../acp-spec) | cody | Review with concrete spec/CLI/store edits |
| T-01248 | Spec PR | cody | acp-spec commit `a4102e6`; 6 files |
| T-01249 | Outbound Phase 1 — storage + endpoint | larry | `outbound_attachments` table; `POST/GET /v1/runs/:runId/outbound-attachments`; `AttachmentRef.alt` |
| T-01250 | Outbound Phase 2 — CLI | cody | `acp run attachment add/list/clear` with `--run/--alt/--filename/--content-type/--json` |
| T-01251 | Outbound Phase 3 — delivery integration | cody | `interface-response-capture.ts` consume + denormalize; gateway threads `alt` to `media_ref.alt` and `description` |
| T-01252 | Outbound Phase 4 — codex prompt | curly | `~/praesidium/var/agents/conventions.md` "Sending images back" instruction |
| T-01253 | Outbound Phase 5 — validation | smokey | All package tests green; HRC_GENERATION fence enforcement defect found + fixed |

## Live e2e smoke (2026-04-25)

- **Ingress** (post-T-01246 fix): virtu sent `test-icon.png` (15089 bytes, 128×128 ghostty icon) → ACP downloaded to `state/media/attachments/run_*/test-icon.png` → cody dispatch with `codex exec ... -i <path>` → cody replied: *"A glossy rounded-square app icon with a black and gray border, dark blue gradient background, and a small pale blue ghost-like character in the upper left with simple dark eyes."* ✅
- **Egress** (post-T-01253): virtu prompted cody to copy a file then run the new CLI → cody ran `acp run attachment add /tmp/cody-egress-test.png --alt ghost-icon-test` → Discord channel received message with file `cody-egress-test.png` (15089 bytes, image/png), `description: ghost-icon-test`. ✅

## Architecture (locked, as shipped)

- **Storage layout:** `state/media/attachments/<runId>/` (inbound) and `state/media/outbound/<runId>/` (outbound).
- **Contract:** `AttachmentRef { kind: 'url'|'file', url?, path?, filename?, contentType?, sizeBytes?, alt? }` exported from `acp-core` and `spaces-runtime/session`.
- **Endpoint:** `POST /v1/runs/:runId/outbound-attachments` (multipart) + `GET` for inspection. Stable error codes: `run_not_found`, `run_not_accepting_outbound`, `attachment_too_large`, `unsupported_content_type`, `correlation_mismatch`.
- **Correlation:** CLI reads `HRC_RUN_ID` (with `--run` override), forwards `HRC_HOST_SESSION_ID` and `HRC_GENERATION` headers; server enforces against the run's `dispatchFence`.
- **Consumption rule:** pending outbound attachments are consumed by the next visible-assistant `DeliveryRequest`, marked `consumed` with `consumedByDeliveryRequestId`. Run-end with remaining `pending` → marked `failed` (chosen over attachment-only delivery; see Known limitations).
- **Codex CLI integration:** `imageAttachments?: string[]` on `HarnessRunOptions`; codex-adapter emits `-i <path>` per entry; agent-spaces client filters image-typed file refs from `req.attachments`.
- **Gateway:** `delivery.body.attachments` → `media_ref` blocks (with `alt`) → Discord file payloads (with `description` from alt). `fetchMediaAttachments` now also handles local-file URLs (added in T-01251).

## Remaining work / fixes

### Must-do before merge

1. **Commit the Discord image work to git.** 53 files modified/untracked across `packages/acp-core`, `acp-interface-store`, `acp-server`, `acp-cli`, `agent-spaces`, `harness-codex`, `gateway-discord`, `config`, `runtime`, `hrc-server`. None committed. Suggested grouping by sub-feature:
   - `feat(acp): outbound attachment storage + endpoint` (T-01249)
   - `feat(acp-cli): acp run attachment {add,list,clear}` (T-01250)
   - `feat(acp): consume outbound on delivery enqueue + alt threading` (T-01251)
   - `fix(gateway-discord): wrap messageCreate handler so 5xx does not crash ACP` (T-01245 fix)
   - `fix(hrc): thread image attachments into codex CLI -i <path>` (T-01246 fix)
   - Smaller standalone: `feat(acp-core): AttachmentRef.alt`, `feat(spaces-runtime): AttachmentRef.alt`.
2. **Close T-01245.** The fix landed in `packages/gateway-discord/src/app.ts` (wrapped `handleMessageCreate` in try/catch at the listener boundary). wrkq state is still `open`; close it with the fix-commit reference.
3. **Commit `~/praesidium/var/agents/conventions.md`** (separate `agents` repo). Curly's "Sending images back" instruction is uncommitted there. Mixed in with other unrelated changes (`AGENT_MOTD.md`, `animan/SOUL.md`, etc.) so a focused commit just for `conventions.md` is preferred.

### Known limitations (not blockers; v2 candidates)

4. **Run-end policy is "drop with `failed`."** If cody calls `acp run attachment add` but never produces a visible-assistant message, the attachment is logged + marked failed. Reason: current Discord delivery path doesn't reliably send empty-text attachment-only chunks. v2 could add a delivery-empty-with-attachments path so generated images aren't silently dropped on rare empty-reply turns.
5. **Discord 10-attachment cap not enforced.** Multiple `acp run attachment add` calls beyond 10 in a single delivery will fail at Discord ingest time with a less-than-friendly error. Add a CLI-side or response-capture-side warning + truncate beyond 10.
6. **Codex `view_image` tool is input-only.** Investigated during T-01246; codex's built-in `view_image` produces no image content block in tool output. The new `acp run attachment add` path is the explicit egress mechanism. If we want implicit "echo what codex viewed back to Discord", that requires either a codex CLI change or a wrapper tool.

### HRC operational quirks observed during e2e

7. **`hrc session clear-context --relaunch` spawns `tmux` runtime, not `headless`.** Hit twice during e2e validation. Workaround: terminate the runtime after clear-context, then the next dispatch materializes as `headless`. Worth filing as a defect or documenting as expected behavior — depends on intent.
8. **Apostrophes / shell-special chars in Discord prompts get typed as shell input by the tmux runtime.** When the runtime is `tmux` (instead of headless), HRC injects the prompt as keystrokes; quoted characters cause `quote>` continuation or `command not found` errors and the prompt never reaches codex. Workaround for tests: send plain prose without `'`/`"`/backticks. Real fix: HRC tmux dispatch should escape or prefer the headless path for non-interactive turns.

### Pre-existing failures (not caused by this work; out of scope)

9. **`packages/acp-e2e/test/e2e-defect-fastlane.test.ts`** — 10 tests fail expecting phase `open`, getting `red`. Confirmed unrelated by all three implementer reviews (cody, larry, smokey). Track and fix separately.
10. **`packages/hrc-server`** — ~8 tests fail around runtime lifecycle (capture, attach, headless dispatch). Pre-existing on `main` (verified by stashing this work). Unchanged by this work.

## Phase tasks closed (this work)

T-01237 ✅ T-01238 ✅ T-01239 ✅ T-01240 ✅ T-01241 ✅ T-01246 ✅ T-01247 ✅ T-01248 ✅ T-01249 ✅ T-01250 ✅ T-01251 ✅ T-01252 ✅ T-01253 ✅

## Phase tasks open

T-01245 (gateway crash fix landed; needs closure) — see Remaining work #2.
