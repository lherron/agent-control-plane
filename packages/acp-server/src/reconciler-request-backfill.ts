import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { WorkRpcError } from '@wrkq/client'
import {
  type AcpReconcilerOptions,
  BACKFILL_PRINCIPAL,
  BackfillFailure,
  type BackfillManifest,
  REQUEST_BACKFILL_SOURCE_SHA256,
  type ReconcilerConfig,
  applyBackfill,
  createAcpReconciler,
  planBackfill,
  validateManifest,
} from 'acp-reconciler'
import type { JobNodeIdentityAuthority } from './jobs/node-identity.js'
import type { WrkfLifecycle } from './wrkf/client-lifecycle.js'

const HOST_SOURCE_SHA256 = createHash('sha256')
  .update(readFileSync(import.meta.filename))
  .digest('hex')
type IdentityAuthority = Pick<JobNodeIdentityAuthority, 'verifyFresh'>
type Receipt = {
  operation: 'plan' | 'apply'
  requestId: string
  hostId: string
  pid: number
  startedAt: string
  finishedAt?: string
  producer: string
  target: string
  node?: string
  manifestSha256?: string
  /** Content revisions captured at module load; never a current-HEAD claim. */
  consumedRevision: { hostSha256: string; routineSha256: string }
}
export type RequestBackfillReply = {
  status: number
  receipt: Receipt
  result?: unknown
  error?: {
    code: string
    message: string
    effectsUncertain: boolean
    progress?: unknown
    causeCode?: string
  }
}
export type RequestBackfillCapability = {
  plan(requestId: string): Promise<RequestBackfillReply>
  apply(manifest: unknown, expectedSha256: string, requestId: string): Promise<RequestBackfillReply>
}

type HostedReconcilerInput = {
  config: ReconcilerConfig | undefined
  lifecycle: Pick<WrkfLifecycle, 'clientForPrincipal'>
  target: string
  nodeAuthority: IdentityAuthority
  log?: AcpReconcilerOptions['log']
  hrcClient?: AcpReconcilerOptions['hrcClient']
  receiptLog?: ((reply: RequestBackfillReply) => void) | undefined
}
/** One resolution, one exact client object shared by normal reconciler and maintenance. */
export async function createHostedReconciler(input: HostedReconcilerInput) {
  const { config } = input
  if (config === undefined) return { reconciler: undefined, requestBackfill: undefined }
  const activeConfig = config
  const client = await input.lifecycle.clientForPrincipal(config.principalRef)
  const reconciler = createAcpReconciler({
    config,
    workClient: client,
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.hrcClient === undefined ? {} : { hrcClient: input.hrcClient }),
  })
  const hostId = randomUUID()
  let busy = false
  async function execute(
    operation: 'plan' | 'apply',
    requestId: string,
    manifest?: unknown,
    expected?: string
  ): Promise<RequestBackfillReply> {
    const receipt: Receipt = {
      operation,
      requestId,
      hostId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      producer: activeConfig.principalRef,
      target: input.target,
      consumedRevision: {
        hostSha256: HOST_SOURCE_SHA256,
        routineSha256: REQUEST_BACKFILL_SOURCE_SHA256,
      },
    }
    const finish = (reply: Omit<RequestBackfillReply, 'receipt'>): RequestBackfillReply => {
      receipt.finishedAt = new Date().toISOString()
      const result = { ...reply, receipt }
      input.receiptLog?.(result)
      return result
    }
    const error = (
      status: number,
      code: string,
      message: string,
      effectsUncertain = false,
      extra = {}
    ) => finish({ status, error: { code, message, effectsUncertain, ...extra } })
    if (busy) return error(409, 'backfill_busy', 'maintenance operation already running')
    busy = true
    let applying = false
    try {
      if (activeConfig.principalRef !== BACKFILL_PRINCIPAL)
        return error(503, 'backfill_unavailable', 'configured reconciler producer differs')
      const verified = await input.nodeAuthority.verifyFresh('manual_run')
      if (!verified.ok)
        return error(503, 'backfill_node_unavailable', 'current HRC node authority unavailable')
      receipt.node = verified.identity.nodeId
      if (receipt.node !== activeConfig.node)
        return error(503, 'backfill_wrong_node', 'not the designated reconciler node')
      if (operation === 'plan') {
        const result = await planBackfill(client, input.target)
        receipt.manifestSha256 = result.sha256
        return finish({ status: 200, result })
      }
      let reviewed: BackfillManifest
      try {
        reviewed = validateManifest(manifest, input.target, expected ?? '')
      } catch {
        return error(
          400,
          'backfill_manifest_invalid',
          'reviewed manifest digest, target or shape mismatch'
        )
      }
      receipt.manifestSha256 = reviewed.sha256
      applying = true
      const result = await applyBackfill(client, reviewed, input.target, reviewed.sha256)
      return finish({ status: 200, result })
    } catch (cause) {
      const underlying = cause instanceof BackfillFailure ? cause.cause : cause
      return error(
        502,
        'backfill_stopped',
        'inspect owner state before explicit same-manifest reconciliation',
        applying,
        {
          ...(cause instanceof BackfillFailure ? { progress: cause.progress } : {}),
          ...(underlying instanceof WorkRpcError && underlying.domainCode
            ? { causeCode: underlying.domainCode }
            : {}),
        }
      )
    } finally {
      busy = false
    }
  }
  const requestBackfill: RequestBackfillCapability = {
    plan: (requestId) => execute('plan', requestId),
    apply: (manifest, expected, requestId) => execute('apply', requestId, manifest, expected),
  }
  return { reconciler, requestBackfill }
}
