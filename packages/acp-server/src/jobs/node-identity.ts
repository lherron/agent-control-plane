import type { JobsStore } from 'acp-jobs-store'
import type { HrcClient } from 'hrc-sdk'

export type JobExecutionNodeMode = 'single-node' | 'federated'

export type VerifiedJobExecutionIdentity = Readonly<{
  nodeId: string
  mode: JobExecutionNodeMode
  verifiedAt: string
}>

export type JobIdentityFailureCode =
  | 'hrc_client_unavailable'
  | 'hrc_identity_unavailable'
  | 'hrc_identity_missing'
  | 'startup_identity_unavailable'
  | 'hrc_identity_changed'

export type JobIdentityVerification =
  | { ok: true; identity: VerifiedJobExecutionIdentity }
  | {
      ok: false
      code: JobIdentityFailureCode
      message: string
      current?: Readonly<{ nodeId: string; mode: JobExecutionNodeMode }> | undefined
    }

export function stampLegacyJobRunsAfterIdentity(
  jobsStore: JobsStore,
  verification: JobIdentityVerification
): { stamped: number } {
  if (!verification.ok) {
    return { stamped: 0 }
  }
  return jobsStore.stampLegacyNonterminalJobRuns(verification.identity.nodeId)
}

export type JobNodeIdentityDiagnostics = Readonly<{
  startupState: 'uninitialized' | 'ready' | 'failed'
  baseline?: Readonly<{ nodeId: string; mode: JobExecutionNodeMode }> | undefined
  current?: Readonly<{ nodeId: string; mode: JobExecutionNodeMode }> | undefined
  lastVerifiedAt?: string | undefined
  lastFailure?:
    | Readonly<{
        code: JobIdentityFailureCode
        message: string
        at: string
      }>
    | undefined
  quiesced: boolean
}>

type JobIdentityHrcClient = Pick<HrcClient, 'getStatus'>

type NodeIdentity = Readonly<{ nodeId: string; mode: JobExecutionNodeMode }>

function isNodeMode(value: unknown): value is JobExecutionNodeMode {
  return value === 'single-node' || value === 'federated'
}

export class JobNodeIdentityAuthority {
  private readonly client: JobIdentityHrcClient | undefined
  private startupState: JobNodeIdentityDiagnostics['startupState'] = 'uninitialized'
  private baseline: NodeIdentity | undefined
  private current: NodeIdentity | undefined
  private lastVerifiedAt: string | undefined
  private lastFailure: JobNodeIdentityDiagnostics['lastFailure']
  private quiescedFailure: Readonly<{ code: 'hrc_identity_changed'; message: string }> | undefined

  constructor(client: JobIdentityHrcClient | undefined) {
    this.client = client
  }

  async initialize(): Promise<JobIdentityVerification> {
    if (this.startupState !== 'uninitialized') {
      return this.baseline === undefined
        ? this.failure(
            'startup_identity_unavailable',
            'job execution identity baseline was not established at startup'
          )
        : {
            ok: true,
            identity: {
              ...this.baseline,
              verifiedAt: this.lastVerifiedAt ?? new Date().toISOString(),
            },
          }
    }

    const fresh = await this.readFresh()
    if (!fresh.ok) {
      this.startupState = 'failed'
      return fresh
    }
    this.baseline = { nodeId: fresh.identity.nodeId, mode: fresh.identity.mode }
    this.startupState = 'ready'
    return fresh
  }

  async verifyFresh(_context: 'scheduler_tick' | 'manual_run'): Promise<JobIdentityVerification> {
    const fresh = await this.readFresh()
    if (!fresh.ok) {
      return fresh
    }
    if (this.baseline === undefined) {
      return this.failure(
        'startup_identity_unavailable',
        'job execution identity baseline was not established at startup',
        fresh.identity
      )
    }
    if (
      fresh.identity.nodeId !== this.baseline.nodeId ||
      fresh.identity.mode !== this.baseline.mode
    ) {
      if (this.quiescedFailure === undefined) {
        this.quiescedFailure = {
          code: 'hrc_identity_changed',
          message:
            `HRC job execution identity changed from ${this.baseline.nodeId}/${this.baseline.mode}` +
            ` to ${fresh.identity.nodeId}/${fresh.identity.mode}; ACP restart is required`,
        }
      }
      return this.failure(this.quiescedFailure.code, this.quiescedFailure.message, fresh.identity)
    }
    if (this.quiescedFailure !== undefined) {
      return this.failure(this.quiescedFailure.code, this.quiescedFailure.message, fresh.identity)
    }

    return fresh
  }

  getDiagnostics(): JobNodeIdentityDiagnostics {
    return {
      startupState: this.startupState,
      ...(this.baseline !== undefined ? { baseline: this.baseline } : {}),
      ...(this.current !== undefined ? { current: this.current } : {}),
      ...(this.lastVerifiedAt !== undefined ? { lastVerifiedAt: this.lastVerifiedAt } : {}),
      ...(this.lastFailure !== undefined ? { lastFailure: this.lastFailure } : {}),
      quiesced: this.quiescedFailure !== undefined,
    }
  }

  private async readFresh(): Promise<JobIdentityVerification> {
    const at = new Date().toISOString()
    if (this.client === undefined) {
      return this.failure('hrc_client_unavailable', 'HRC client is unavailable', undefined, at)
    }

    let status: Awaited<ReturnType<JobIdentityHrcClient['getStatus']>>
    try {
      status = await this.client.getStatus({ includeSessions: false })
    } catch (error) {
      return this.failure(
        'hrc_identity_unavailable',
        `fresh HRC status read failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        at
      )
    }

    const node = status.node
    if (
      typeof node?.nodeId !== 'string' ||
      node.nodeId.trim().length === 0 ||
      !isNodeMode(node.mode)
    ) {
      return this.failure(
        'hrc_identity_missing',
        'fresh HRC status did not contain a valid nodeId and mode',
        undefined,
        at
      )
    }

    const identity: VerifiedJobExecutionIdentity = {
      nodeId: node.nodeId.trim(),
      mode: node.mode,
      verifiedAt: at,
    }
    this.current = { nodeId: identity.nodeId, mode: identity.mode }
    this.lastVerifiedAt = at
    this.lastFailure = undefined
    return { ok: true, identity }
  }

  private failure(
    code: JobIdentityFailureCode,
    message: string,
    current?: Readonly<{ nodeId: string; mode: JobExecutionNodeMode }> | undefined,
    at = new Date().toISOString()
  ): JobIdentityVerification {
    if (current !== undefined) {
      this.current = { nodeId: current.nodeId, mode: current.mode }
    }
    this.lastFailure = { code, message, at }
    return {
      ok: false,
      code,
      message,
      ...(current !== undefined ? { current: this.current } : {}),
    }
  }
}

export function createJobNodeIdentityAuthority(
  client: JobIdentityHrcClient | undefined
): JobNodeIdentityAuthority {
  return new JobNodeIdentityAuthority(client)
}

export function formatJobIdentityMissedTickDiagnostic(
  store: JobsStore | undefined,
  verification: Exclude<JobIdentityVerification, { ok: true }>,
  now: Date
): string {
  const nowIso = now.toISOString()
  const dueJobs =
    store
      ?.listJobs()
      .jobs.filter(
        (job) =>
          job.trigger.kind === 'schedule' &&
          !job.disabled &&
          job.archivedAt === undefined &&
          job.nextFireAt !== undefined &&
          job.nextFireAt <= nowIso
      ) ?? []
  const catchUpEnabled = dueJobs.filter((job) => job.schedule?.catchUp === 'one').length
  const nonCatchUp = dueJobs.length - catchUpEnabled
  return (
    `acp-server jobs scheduler tick skipped: ${verification.code}: ${verification.message}; ` +
    `due schedules catch-up-enabled=${catchUpEnabled}, non-catch-up=${nonCatchUp}; ` +
    `${nonCatchUp} non-catch-up occurrence(s) may not be recovered`
  )
}
