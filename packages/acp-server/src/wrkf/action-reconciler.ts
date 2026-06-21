import type { AcpWrkfWorkflowPort } from './port.js'
import { isRecord } from './value.js'

/**
 * HRC→wrkf failure reconciliation safety net (T-05034, daedalus-locked).
 *
 * Completion ownership is HYBRID with worker-direct (A) canonical: the launched
 * worker is the SOLE semantic-completion authority. It calls `wrkf.action.complete`
 * (success) or `wrkf.action.fail` (failure) for its actionRunId before ending its
 * turn. ACP never infers success from an HRC terminal state.
 *
 * This reconciler is the ACP-owned safety net and it can ONLY fail, never complete.
 * When the bound HRC run reaches a non-semantic terminal state
 * (`failed`/`cancelled`/`zombie`), OR reaches `completed` without a wrkf terminal
 * state after a grace window (a PROTOCOL BREACH), AND the wrkf action run is still
 * active, it records `wrkf.action.fail` exactly once with run-linked
 * `failure_result` evidence referencing `hrc:<hrcRunId>`.
 *
 * Idempotency is driven by wrkf truth, not local state: every attempt reads
 * `wrkf.action.show` first and no-ops if the action is already terminal. The
 * `failure_result` payload and `idempotencyKey` are derived deterministically from
 * `actionRunId` + `hrcRunId`, so replayed/duplicate HRC terminal events produce
 * byte-identical params and wrkf's own idempotency dedup applies.
 *
 * ACP MUST NEVER call `wrkf.action.complete`. Success authority belongs
 * exclusively to the launched worker — the reconciler has no such code path.
 */

export type HrcRunTerminalStatus = 'failed' | 'cancelled' | 'zombie' | 'completed'

export type ReconcileActionHrcInput = {
  /** The semantic wrkf action run id. */
  actionRunId: string
  /** The underlying wrkf run id (ACP run store key). */
  wrkfRunId: string
  /** Bare HRC run id (externalRunRef = `hrc:<hrcRunId>`). */
  hrcRunId: string
  hrcTerminalStatus: HrcRunTerminalStatus
  taskId: string
  /**
   * Deterministic key derived from actionRunId + hrcRunId. Accepted from the
   * caller for traceability, but the reconciler always derives its own canonical
   * key so the fail call is idempotent regardless of caller input.
   */
  idempotencyKey: string
}

/** Params shape the reconciler hands to `wrkf.action.fail`. */
export type WrkfActionFailParams = {
  actionRunId: string
  summary: string
  failureResult?: Record<string, unknown>
  idempotencyKey?: string
}

/**
 * The reconciler needs the base port PLUS `action.show` + `action.fail`.
 * `action.complete` is intentionally absent: the reconciler must never call it.
 */
export type AcpWrkfWorkflowPortWithActionOps = Omit<AcpWrkfWorkflowPort, 'action'> & {
  action: AcpWrkfWorkflowPort['action'] & {
    show(params: { actionRunId: string }): Promise<unknown>
    fail(params: WrkfActionFailParams): Promise<unknown>
  }
}

export type ReconcileActionHrcDeps = {
  wrkf: AcpWrkfWorkflowPortWithActionOps
}

export type ReconcileActionHrcResult = {
  outcome: 'no_op' | 'failed_action' | 'breach_recorded'
  /** True when the action was already terminal on entry (no-op fast path). */
  alreadyTerminal: boolean
}

const RUNTIME_TERMINAL: ReadonlySet<HrcRunTerminalStatus> = new Set([
  'failed',
  'cancelled',
  'zombie',
])

export async function reconcileActionHrcTerminal(
  deps: ReconcileActionHrcDeps,
  input: ReconcileActionHrcInput
): Promise<ReconcileActionHrcResult> {
  // A. Read wrkf truth first — idempotency is driven by the action ledger, not
  //    local state.
  const shown = await deps.wrkf.action.show({ actionRunId: input.actionRunId })

  // B. Already-terminal fast path: the action ledger is the source of truth. If
  //    the worker (or a prior reconcile) already drove it terminal, no-op.
  if (isAlreadyTerminal(shown)) {
    return { outcome: 'no_op', alreadyTerminal: true }
  }

  // Deterministic correlation artifacts — identical across replays of the same
  // (actionRunId, hrcRunId) so wrkf's idempotency dedup applies.
  const hrcRef = `hrc:${input.hrcRunId}`
  const idempotencyKey = `reconcile:${input.actionRunId}:${input.hrcRunId}`

  if (RUNTIME_TERMINAL.has(input.hrcTerminalStatus)) {
    // C. Runtime terminated abnormally → fail the still-active action once.
    await deps.wrkf.action.fail({
      actionRunId: input.actionRunId,
      summary: `HRC runtime terminated: ${input.hrcTerminalStatus}`,
      failureResult: {
        hrcRunId: hrcRef,
        hrcStatus: input.hrcTerminalStatus,
        reconciledBy: 'acp-reconciler',
      },
      idempotencyKey,
    })
    return { outcome: 'failed_action', alreadyTerminal: false }
  }

  // D. PROTOCOL BREACH: HRC reached `completed` but the worker never recorded a
  //    semantic terminal state. ACP MUST NOT infer success. Mark the action
  //    failed with a breach summary referencing the hrc run. Never complete.
  await deps.wrkf.action.fail({
    actionRunId: input.actionRunId,
    summary: 'runtime completed without semantic completion',
    failureResult: {
      hrcRunId: hrcRef,
      hrcStatus: 'completed',
      breach: 'runtime_completed_no_semantic',
      reconciledBy: 'acp-reconciler',
    },
    idempotencyKey,
  })
  return { outcome: 'breach_recorded', alreadyTerminal: false }
}

/**
 * A wrkf action run is terminal when `action.show` reports a status other than
 * `active`. A missing/unreadable status is treated as still-active (proceed),
 * matching the conservative "act unless proven terminal" stance.
 */
function isAlreadyTerminal(shown: unknown): boolean {
  if (!isRecord(shown)) {
    return false
  }
  const status = shown['status']
  return typeof status === 'string' && status.length > 0 && status !== 'active'
}
