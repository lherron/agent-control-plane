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
  next(params: { task: string; [key: string]: unknown }): Promise<unknown>
  evidence: {
    add(params: Record<string, unknown>): Promise<unknown>
    list(params: { task: string }): Promise<unknown>
    show(params: { id: string }): Promise<unknown>
    suggest(params: { task: string; transition: string }): Promise<unknown>
  }
  obligation: {
    list(params: { task: string }): Promise<unknown>
    show(params: { id: string }): Promise<unknown>
    satisfy(params: Record<string, unknown>): Promise<unknown>
    waive(params: Record<string, unknown>): Promise<unknown>
    cancel(params: Record<string, unknown>): Promise<unknown>
  }
  transition: {
    apply(params: Record<string, unknown>): Promise<unknown>
  }
  run: {
    start(params: Record<string, unknown>): Promise<unknown>
    bindExternal(params: Record<string, unknown>): Promise<unknown>
    finish(params: Record<string, unknown>): Promise<unknown>
    fail(params: Record<string, unknown>): Promise<unknown>
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
    deliver(params: Record<string, unknown>): Promise<unknown>
  }
}
