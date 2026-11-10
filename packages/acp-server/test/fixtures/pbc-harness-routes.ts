import { expect } from 'bun:test'

import type {
  ApproveTransitionRequest,
  PbcHarnessResult,
  RunStepRequest,
  RunUntilBlockedRequest,
} from '../../src/wrkf/pbc-harness.js'
import type { AcpWrkfWorkflowPort } from '../../src/wrkf/port.js'
import type { FakePbcHarnessPort } from './pbc-harness-port.js'
import { withWiredServer } from './wired-server.js'

// ---------------------------------------------------------------------------
// Route surface: every operation goes through the real ACP router
// (POST /v1/wrkf/pbc/tasks/:task/{run-step,approve-transition,run-until-blocked})
// with the fake port mounted as deps.wrkf — the wrkf daemon boundary.
// Each call gets a fresh wired server, so the route's own idempotency store
// never short-circuits a repeated call; harness-level dedupe stays observable.
// ---------------------------------------------------------------------------

type PbcRouteOp = 'run-step' | 'approve-transition' | 'run-until-blocked'

type PbcRouteResponse = { status: number; body: Record<string, unknown> }

export async function postPbcRoute(
  port: FakePbcHarnessPort,
  op: PbcRouteOp,
  input: { task: string; routeKey?: string } & Record<string, unknown>
): Promise<PbcRouteResponse> {
  const { task, routeKey, ...rest } = input
  const body = routeKey !== undefined ? { ...rest, idempotencyKey: routeKey } : rest
  return withWiredServer(
    async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/wrkf/pbc/tasks/${task}/${op}`,
        body,
      })
      return {
        status: response.status,
        body: await fixture.json<Record<string, unknown>>(response),
      }
    },
    { wrkf: port as unknown as AcpWrkfWorkflowPort }
  )
}

async function expectPbcRouteOk(
  port: FakePbcHarnessPort,
  op: PbcRouteOp,
  input: { task: string; routeKey?: string } & Record<string, unknown>
): Promise<PbcHarnessResult> {
  const response = await postPbcRoute(port, op, input)
  expect(response.status).toBe(200)
  return response.body as unknown as PbcHarnessResult
}

export function runStepRoute(port: FakePbcHarnessPort, input: RunStepRequest) {
  return expectPbcRouteOk(port, 'run-step', { ...input })
}

export function approveTransitionRoute(port: FakePbcHarnessPort, input: ApproveTransitionRequest) {
  return expectPbcRouteOk(port, 'approve-transition', { ...input })
}

export function runUntilBlockedRoute(port: FakePbcHarnessPort, input: RunUntilBlockedRequest) {
  return expectPbcRouteOk(port, 'run-until-blocked', { ...input })
}
