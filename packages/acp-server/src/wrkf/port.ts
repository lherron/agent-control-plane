export type WrkfActor = string | { kind: string; id: string }

export type WrkfEvidenceAddParams = {
  task: string
  kind: string
  ref?: string | undefined
  summary?: string | undefined
  facts?: Record<string, unknown> | undefined
  data?: unknown
  principal_ref?: WrkfActor | undefined
  role?: string | undefined
}

export type WrkfTransitionApplyParams = {
  task: string
  transition: string
  role?: string | undefined
  principal_ref?: WrkfActor | undefined
  expectRevision?: number | undefined
  contextHash?: string | undefined
  idempotencyKey?: string | undefined
  checkIds?: string[] | undefined
  runChecks?: boolean | undefined
  dryRun?: boolean | undefined
}

export type WrkfRunStartParams = {
  task: string
  role: string
  principal_ref?: WrkfActor | undefined
  idempotencyKey?: string | undefined
  deliveryRef?: string | undefined
  lane?: string | undefined
  externalRunRef?: string | undefined
}

/**
 * Params for `wrkf.action.start` (C-0001). Mirrors the installed
 * `@wrkq/client` `WrkfActionStartParams`. `action` selects the semantic step
 * (triage/implement/review/verify or a custom string); wrkf defaults the role
 * from the action when `role` is omitted and auto-installs the built-in
 * `wrkq-simple-task` workflow on an un-workflowed task.
 */
export type WrkfActionStartParams = {
  task?: string | undefined
  instanceId?: string | undefined
  workflow?: string | undefined
  action: string
  role?: string | undefined
  principal_ref?: WrkfActor | undefined
  lane?: string | undefined
  deliveryRef?: string | Record<string, unknown> | undefined
  externalRunRef?: string | undefined
  idempotencyKey?: string | undefined
}

/**
 * Params for `wrkf.action.bindExternal` (C-0002). Mirrors the installed
 * `@wrkq/client` `WrkfActionBindExternalParams`. Keys on `actionRunId` (NOT the
 * underlying run id). wrkf normalizes `externalRunRef` to `hrc:<id>` and rejects
 * a conflicting ref bound to a different run.
 */
export type WrkfActionBindExternalParams = {
  actionRunId: string
  externalRunRef: string
  deliveryRef?: string | Record<string, unknown> | undefined
  lane?: string | undefined
  idempotencyKey?: string | undefined
}

/**
 * Params for `wrkf.action.show` (C-0003). Reads the current action run record so
 * the reconciler can no-op when the action is already terminal (idempotency
 * driven by wrkf truth).
 */
export type WrkfActionShowParams = {
  actionRunId: string
}

/**
 * Params for `wrkf.action.fail`. The ACP reconciler hands a flat
 * `failureResult` + `idempotencyKey`; the client shim maps these onto the
 * underlying `@wrkq/client` `evidence` envelope. ACP exposes NO `action.complete`
 * on this port — semantic success authority belongs to the launched worker only.
 */
export type WrkfActionFailParams = {
  actionRunId: string
  summary: string
  failureResult?: Record<string, unknown> | undefined
  idempotencyKey?: string | undefined
}

export type WrkfActionClaimParams = {
  task?: string | undefined
  instanceId?: string | undefined
  prefer?: {
    instanceId?: string | undefined
    semanticActionKey?: string | undefined
    action?: string | undefined
  }
  runnerId: string
  agentRef: string
  scopeRef?: string | undefined
  leaseMs: number
  capabilities?: Array<Record<string, unknown>> | undefined
  idempotencyKey?: string | undefined
}

export type WrkfRunFinishParams = {
  runId: string
  summary?: string | undefined
  status?: string | undefined
}

export type WrkfRunFailParams = {
  runId: string
  summary?: string | undefined
}

export type WrkfEffectDeliverParams = {
  effectId: string
  adapter?: string | undefined
}

export type AcpWrkfWorkflowPort = {
  workflow: {
    validate(params: { path: string }): Promise<unknown>
    show(params: { ref: string }): Promise<unknown>
    list(params?: Record<string, unknown>): Promise<unknown>
    diff(params: { oldPath: string; newPath: string }): Promise<unknown>
    install(params: { path: string }): Promise<unknown>
  }
  task: {
    attach(params: { task: string; workflow: string }): Promise<unknown>
    inspect(params: { task: string }): Promise<unknown>
    timeline(params: { task: string }): Promise<unknown>
    refresh(params: { task: string }): Promise<unknown>
    syncMeta(params: { task: string }): Promise<unknown>
  }
  next(params: { task: string; role?: string | undefined }): Promise<unknown>
  evidence: {
    add(params: WrkfEvidenceAddParams): Promise<unknown>
    list(params: { task: string }): Promise<unknown>
    show(params: { id: string }): Promise<unknown>
    suggest(params: { task: string; transition: string }): Promise<unknown>
  }
  obligation: {
    list(params: { task: string }): Promise<unknown>
    show(params: { id: string }): Promise<unknown>
    satisfy(params: {
      task: string
      id: string
      evidenceId?: string | undefined
      /** wrkf enforces ownerRole on obligation.satisfy; forward caller's role/principal_ref. */
      role?: string | undefined
      principal_ref?: string | undefined
      reason?: string | undefined
    }): Promise<unknown>
    waive(params: Record<string, unknown>): Promise<unknown>
    cancel(params: Record<string, unknown>): Promise<unknown>
  }
  transition: {
    apply(params: WrkfTransitionApplyParams): Promise<unknown>
  }
  run: {
    start(params: WrkfRunStartParams): Promise<unknown>
    bindExternal(params: Record<string, unknown>): Promise<unknown>
    finish(params: WrkfRunFinishParams): Promise<unknown>
    fail(params: WrkfRunFailParams): Promise<unknown>
    show(params: { id: string }): Promise<unknown>
    list(params: { task: string }): Promise<unknown>
  }
  /**
   * Low-ceremony action surface (C-0001/C-0002). `start` opens (or idempotently
   * replays) one semantic action run; `bindExternal` binds the canonical HRC
   * ref to that action run. The ACP action-launch adapter composes these around
   * an HRC launch — see `wrkf/action-launch.ts`.
   */
  action: {
    claim?(params: WrkfActionClaimParams): Promise<unknown>
    start(params: WrkfActionStartParams): Promise<unknown>
    bindExternal(params: WrkfActionBindExternalParams): Promise<unknown>
    /** Read current action-run truth (used by the HRC→wrkf reconciler). */
    show(params: WrkfActionShowParams): Promise<unknown>
    /**
     * Fail-only safety net for the reconciler. NOTE: `action.complete` is
     * intentionally NOT on this port — ACP never asserts semantic success.
     */
    fail(params: WrkfActionFailParams): Promise<unknown>
  }
  effect: {
    list(params: Record<string, unknown>): Promise<unknown>
    show(params: { id: string }): Promise<unknown>
    claim(params: Record<string, unknown>): Promise<unknown>
    ack(params: Record<string, unknown>): Promise<unknown>
    fail(params: Record<string, unknown>): Promise<unknown>
    retry(params: Record<string, unknown>): Promise<unknown>
    deliver(params: WrkfEffectDeliverParams): Promise<unknown>
  }
}
