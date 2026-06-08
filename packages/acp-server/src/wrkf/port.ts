export type WrkfActor = string | { kind: string; id: string }

export type WrkfEvidenceAddParams = {
  task: string
  kind: string
  ref?: string | undefined
  summary?: string | undefined
  facts?: Record<string, unknown> | undefined
  data?: unknown
  actor?: WrkfActor | undefined
  role?: string | undefined
}

export type WrkfTransitionApplyParams = {
  task: string
  transition: string
  role?: string | undefined
  actor?: WrkfActor | undefined
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
  actor?: WrkfActor | undefined
  idempotencyKey?: string | undefined
  deliveryRef?: string | undefined
  lane?: string | undefined
  externalRunRef?: string | undefined
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
      /** wrkf enforces ownerRole on obligation.satisfy; forward caller's role/actor. */
      role?: string | undefined
      actor?: string | undefined
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
