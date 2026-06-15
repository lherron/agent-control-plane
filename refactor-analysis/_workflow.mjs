export const meta = {
  name: 'acp-packages-refactor-pass',
  description: 'Analyze→apply→verify behavior-preserving refactors across all ACP packages, then repair breakage',
  phases: [
    { title: 'Analyze' }, { title: 'Apply' }, { title: 'Verify' }, { title: 'Repair' },
  ],
}

const REPO = '/Users/lherron/praesidium/agent-control-plane'

const FALLBACK_TARGETS = [
  'acp-admin-store', 'acp-cli', 'acp-conversation', 'acp-core', 'acp-e2e',
  'acp-interface-store', 'acp-jobs-store', 'acp-ops-projection', 'acp-ops-reducer',
  'acp-ops-web', 'acp-server', 'acp-state-store', 'acp-viewer', 'coordination-substrate',
  'gateway-discord', 'gateway-ios', 'wlearn', 'wrkq-lib',
]

function resolveTargets(a, fallback) {
  if (Array.isArray(a) && a.length) return a
  if (typeof a === 'string' && a.trim()) {
    try { const p = JSON.parse(a); if (Array.isArray(p) && p.length) return p } catch (_) {}
    const parts = a.split(/[,\s]+/).filter(Boolean)
    if (parts.length) return parts
  }
  return fallback
}
const targets = resolveTargets(args, FALLBACK_TARGETS)

// ---- known pre-existing red baseline (subtract from the gate) ----
const BASELINE_RED = `KNOWN PRE-EXISTING TEST FAILURES (do NOT count these as regressions — they exist on the clean baseline):
The repo has exactly 9 pre-existing failing tests, ALL in package acp-server, all "REAL-PROCESS" wrkf
fidelity-guard tests that fail with: WrkfRpcError "rpc.initialize must be called first" (a wrkf-daemon /
@wrkf/client wire-contract skew, unrelated to refactoring). Their suite names contain:
  - "wrkf generic non-PBC smoke (T-02589)"
  - "W5 real-process: @wrkf/client effect shape contract (fidelity guard)" (5 tests)
  - "W2a real-process: @wrkf/client task.inspect + next shape contract (fidelity guard)" (3 tests)
Treat testOk=true when the ONLY failing tests are these (<=9, all matching the above + the rpc.initialize
error). ANY other failing test, OR more than 9 failures, OR an acp-server failure NOT matching that
pattern => testOk=false and you MUST list it in failingPackages + errorExcerpt.`

const DETECTION_GUIDE = `MECHANISM-FIRST REFACTORING TECHNIQUES (route every smell to the structural mechanism that repairs it; do NOT produce a SOLID/smell checklist):
A. Make-safe: [T40] characterization tests on the public surface (gates everything).
B. Boundary (highest leverage): [T07] align interface to actual usage (narrow fat exports, widen leaky ones); [M02] Expand/Contract for any public-contract change (add-new->support-both->migrate->remove-old; drop for leaf packages with no consumers).
C. Seams & structure: [T01] introduce substitution seam (new Concrete()/singletons/statics in logic); [T16] collapse premature abstraction / de-abstract (one-implementor interfaces, single-instantiation generics, never-flipped flags) — REMOVE structure whose variation never materialized; [T15] extract missing abstraction (duplicated intent, magic numbers, primitive obsession); [T03] relocate by affinity/cohesion (feature envy, low-cohesion files, N-file changes); [T19] conditional<->dispatch (type/enum switch growing one arm per feature -> dispatch, or one-axis hierarchy used once -> inline).
D. Invariants: [T12] make illegal states unrepresentable; [T10] reify implicit state machine; [T17] partial->total (throwing/no-op overrides, "can't happen" default arms).
E. Quality: [T18] restructure error handling (swallowed catch{}, exceptions for expected outcomes); [T23] remove middle man / collapse pass-throughs; [T22] guard clauses / flatten nesting (>=4 deep); [T21] introduce parameter object (param lists >4, data clumps).
Package-type swaps: concurrent -> [T31] shared-mutable->immutable/message-passing, [T32] atomic check-then-act (highest severity when present); data -> [T27] normalize, [T13] push invariant to constraint, [T24] batch N+1; perf -> [T25] hoist loop-invariant work, [T26] memoize at referentially-transparent seam; leaf -> drop M02.
PRESSURE-TEST each finding before writing: verify the smell still exists (re-read; many magic-number/dup smells are already fixed); honor contraindications (load-bearing duplication, deliberate option seams); mark direction honestly (expect real de-abstraction, not only "extract more"); spread/projection refactors MUST preserve the exact field set; dedup that parameterizes a typeof literal can trip biome useValidTypeof; name the churn each change creates.
For each finding capture: location (file:line), technique (ID+name), mechanism repaired (structural cause, not the smell), direction (add/remove/relocate/isolate), preservation rung, falsifiable signal, Risk (Low/Med/High), API-impact (internal-only|public-surface), effort, contraindication.`

const REPORT_FORMAT = `Write a Markdown report with sections: Summary; Public boundary (assess first, verdict sound/needs-care/leaky); Findings by mechanism (outside-in, each with location/technique/mechanism/direction/preservation/falsifiable-signal/Risk/API-impact/effort/tests/contraindication); Deliberately left alone (where-NOT); If applying: outside-in sequence; Safety checklist.`

const ANALYZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pkg', 'reportPath', 'filesRead', 'applicableCount', 'deferredCount', 'deferredFindings'],
  properties: {
    pkg: { type: 'string' },
    reportPath: { type: 'string', description: 'repo-relative path to the written report' },
    filesRead: { type: 'integer' },
    applicableCount: { type: 'integer', description: 'count of Low/Med + internal-only items safe to auto-apply' },
    deferredCount: { type: 'integer', description: 'count of High-risk OR public-surface items NOT auto-applicable' },
    summary: { type: 'string' },
    deferredFindings: {
      type: 'array', description: 'EVERY High-risk/public-surface finding — THIS LIST IS SURFACED TO THE USER, be complete, do not summarize away',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'file', 'risk', 'apiImpact', 'reason'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'file:line' },
          technique: { type: 'string', description: 'e.g. T07 align interface' },
          risk: { type: 'string', enum: ['Low', 'Med', 'High'] },
          apiImpact: { type: 'string', enum: ['internal-only', 'public-surface'] },
          reason: { type: 'string', description: 'one line: why it needs a human / why deferred' },
        },
      },
    },
  },
}

const APPLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pkg', 'appliedCount', 'deferred', 'filesChanged', 'selfCheck', 'additionalDeferred'],
  properties: {
    pkg: { type: 'string' },
    appliedCount: { type: 'integer' },
    deferred: { type: 'integer' },
    filesChanged: { type: 'array', items: { type: 'string', description: 'repo-relative path' } },
    appliedSummary: { type: 'string', description: 'one line per applied refactor' },
    selfCheck: {
      type: 'object', additionalProperties: false,
      required: ['typecheckOk', 'testOk', 'note'],
      properties: {
        typecheckOk: { type: 'boolean' },
        testOk: { type: 'boolean', description: 'true if no NEW failures vs baseline (the 9 acp-server pre-existing ones are OK)' },
        note: { type: 'string' },
      },
    },
    additionalDeferred: {
      type: 'array', description: 'items the report tagged applicable but you judged unsafe to auto-apply — surfaced to the user',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'file', 'risk', 'apiImpact', 'reason'],
        properties: {
          title: { type: 'string' }, file: { type: 'string' },
          risk: { type: 'string', enum: ['Low', 'Med', 'High'] },
          apiImpact: { type: 'string', enum: ['internal-only', 'public-surface'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['buildOk', 'typecheckOk', 'testOk', 'failingPackages', 'errorExcerpt'],
  properties: {
    buildOk: { type: 'boolean' },
    typecheckOk: { type: 'boolean' },
    testOk: { type: 'boolean', description: 'true if the ONLY test failures are the 9 known pre-existing acp-server ones' },
    failingPackages: { type: 'array', items: { type: 'string' } },
    errorExcerpt: { type: 'string', description: '<=4000 chars; include new failures only, with file attribution' },
    newFailureCount: { type: 'integer', description: 'count of failures BEYOND the 9 known baseline ones' },
  },
}

const REPAIR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pkg', 'fixed', 'note'],
  properties: {
    pkg: { type: 'string' },
    fixed: { type: 'boolean' },
    revertedRefactor: { type: 'boolean' },
    note: { type: 'string' },
  },
}

const ANALYZE_PROMPT = (t) => `You are a refactoring ANALYST (read-only) for the package at ${REPO}/packages/${t}.
Do NOT edit any source. Read EVERY source file in packages/${t}/ in full (it is small enough). Identify the public boundary (index/exports) and assess it FIRST, then work inward.

${DETECTION_GUIDE}

Pick the package-type profile that fits (general/concurrent/data/perf/leaf) and apply the matching swaps. Refactoring PRESERVES observable behavior — anything that changes behavior is a redesign; flag it as High-risk/public-surface, do not propose it as auto-applicable.

${REPORT_FORMAT}

Create the directory and write the report to ${REPO}/refactor-analysis/${t}-report.md (use mkdir -p). Use repo-relative paths in the report.

Then return the structured result. CRITICAL: deferredFindings MUST contain one entry for EVERY High-risk OR public-surface finding — this list is shown directly to the user and becomes tracked follow-up work, so be complete and specific (real file:line, concrete reason). applicableCount counts only Low/Med + internal-only behavior-preserving items.`

const APPLY_PROMPT = (t, reportPath) => `You are a refactoring APPLIER for package packages/${t} at ${REPO}. Read the analysis report at ${reportPath}.
APPLY ONLY findings that are BOTH (Low or Med risk) AND (internal-only API-impact) AND strictly behavior-preserving (extract function/helper, rename locals, dead-code removal, dedupe, named constants for magic numbers, early-return de-nesting, splitting large PRIVATE functions, collapse premature abstraction with no external consumers).
DO NOT TOUCH: public/exported API signatures, runtime behavior, wire contracts, or any High-risk item. If an item the report tagged applicable looks ambiguous or could change behavior, SKIP it and record it in additionalDeferred.
Edit ONLY files under packages/${t}/. Do not edit other packages, tests of other packages, or shared config.
Watch the known biome traps: a spread {...obj,x} can forward extra fields (use explicit projection); parameterizing a typeof literal trips useValidTypeof (add a scoped // biome-ignore with justification, or restructure).

SELF-VERIFY package-locally BEFORE returning (do NOT run the global build — it collides on shared dist):
  cd ${REPO} && bun run --filter ${t} typecheck
  cd ${REPO} && bun run --filter ${t} test   (if this package has a test script; skip gracefully if not)
${BASELINE_RED}
For acp-server specifically, the 9 known pre-existing failures are acceptable in your self-check — set selfCheck.testOk based on NEW failures only.
If your scoped typecheck/test reveals a NEW failure your edits caused, FIX it or revert that one refactor before returning.

Return the structured result with repo-relative paths in filesChanged. additionalDeferred carries any items you chose not to apply (surfaced to the user).`

const VERIFY_PROMPT = (round) => `You are the VERIFY gate (round ${round}) for the refactor pass at ${REPO}. Run, from ${REPO}, in order (allow ~10 min total):
  bun run lint-fix    (formatting only — NOT a gate; ignore its result for pass/fail)
  bun run build
  bun run typecheck
  bun run test
Attribute any failure to packages/<name>/. Trim errorExcerpt to <=4000 chars.
${BASELINE_RED}
The GATE is build + typecheck + test only (lint is never a gate). Set buildOk/typecheckOk from their exit status. Set testOk=true if the ONLY failing tests are the 9 known pre-existing acp-server ones; otherwise testOk=false. Put NEW failures (count in newFailureCount) into failingPackages + errorExcerpt. Be honest — report actual command results, never a claim.`

const REPAIR_PROMPT = (t, excerpt) => `You are a REPAIR agent for package packages/${t} at ${REPO}. The verify gate failed. Error excerpt:
---
${excerpt}
---
Apply the MINIMAL correct fix for the failure attributable to packages/${t}/. Do NOT weaken or delete tests. If a single refactor is unsalvageable, revert ONLY that one change. Edit only files under packages/${t}/. Then re-run the scoped self-check: cd ${REPO} && bun run --filter ${t} typecheck && bun run --filter ${t} test. Return whether it is fixed.`

// ---------------- run ----------------
phase('Analyze')
log(`Refactor pass over ${targets.length} packages: ${targets.join(', ')}`)
const results = await pipeline(
  targets,
  (t) => agent(ANALYZE_PROMPT(t), { label: `analyze:${t}`, phase: 'Analyze', schema: ANALYZE_SCHEMA }),
  (analysis, t) => analysis && agent(APPLY_PROMPT(t, analysis.reportPath),
    { label: `apply:${t}`, phase: 'Apply', schema: APPLY_SCHEMA }).then(r => r && { ...r, analysis }),
)
const applied = results.filter(Boolean)

phase('Verify')
let verify = await agent(VERIFY_PROMPT(1), { label: 'verify:round-1', phase: 'Verify', schema: VERIFY_SCHEMA })

let round = 0
while (verify && !(verify.buildOk && verify.typecheckOk && verify.testOk) && round < 2) {
  round++
  phase('Repair')
  const failing = [...new Set(verify.failingPackages?.length ? verify.failingPackages
    : applied.flatMap(r => r.filesChanged || []).map(f => (f.match(/packages\/([^/]+)\//) || [])[1]).filter(Boolean))]
  log(`Repair round ${round}: ${failing.join(', ') || '(none identified)'}`)
  await parallel(failing.map(t => () => agent(REPAIR_PROMPT(t, verify.errorExcerpt || ''),
    { label: `repair:${t}`, phase: 'Repair', schema: REPAIR_SCHEMA })))
  phase('Verify')
  verify = await agent(VERIFY_PROMPT(round + 1), { label: `verify:round-${round + 1}`, phase: 'Verify', schema: VERIFY_SCHEMA })
}

const deferredByPackage = applied
  .map(r => ({ pkg: r.pkg || (r.analysis && r.analysis.pkg), items: [...((r.analysis && r.analysis.deferredFindings) || []), ...(r.additionalDeferred || [])] }))
  .filter(g => g.items.length > 0)
const totalDeferred = deferredByPackage.reduce((a, g) => a + g.items.length, 0)
log(`Deferred (too-risky to auto-apply, needs review): ${totalDeferred} items across ${deferredByPackage.length} packages`)

return {
  applied: applied.map(r => ({ pkg: r.pkg, applied: r.appliedCount, deferred: r.deferred, filesChanged: (r.filesChanged || []).length, selfCheck: r.selfCheck })),
  repairRounds: round,
  verify,
  green: !!(verify && verify.buildOk && verify.typecheckOk && verify.testOk),
  deferred: { total: totalDeferred, byPackage: deferredByPackage },
}
