import { resolve } from 'node:path'

import {
  evaluateConsumerDeployment,
  readConsumerDeploymentInputs,
} from '../deployment-coherence.js'
import { json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

const repoRoot = resolve(import.meta.dir, '../../../..')

export const handleGetDeploymentCoherence: RouteHandler = async ({ deps }) => {
  const inputs = await readConsumerDeploymentInputs(repoRoot)
  let runningStatus: { release?: unknown } = {}
  if (deps.hrcClient !== undefined) {
    try {
      runningStatus = await deps.hrcClient.getStatus({ includeSessions: false })
    } catch {
      // The evaluator reports the missing served release and keeps this readback fail closed.
    }
  }
  return json(evaluateConsumerDeployment({ ...inputs, runningStatus }))
}
