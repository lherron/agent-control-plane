import type { WorkClient } from '@wrkq/client'
import type { DispatchAgentInput } from 'acp-jobs-store'
import { formatScopeHandle, parseScopeRef } from 'agent-scope'

/**
 * Flow `agent-dispatch` delivery through the collaboration ledger (T-10378).
 *
 * Prompt delivery to an agent seat is owned by the ledger: ACP's local launch
 * refuses ledger-owned seats ("owned by the collaboration ledger; ACP local
 * launch refused"). The step instead writes one addressed say to the seat's
 * handle, which wrkq routes to the target's task room (or a pair room for a
 * non-task seat), and the HRC kicker presents it, summoning the seat if needed.
 *
 * The say is reply-required on purpose: `--fyi` never births a seat, and an
 * incident seat such as `fettle@agent-control-plane:T-xxxxx` is born by this
 * very prompt.
 */
export function createLedgerAgentDispatch(
  client: WorkClient,
  principalRef: string
): DispatchAgentInput {
  return async (input) => {
    const to = ledgerSeatHandle(input.scopeRef, input.laneRef)
    try {
      const receipt = await client.wrkq.room.say({
        ref: to,
        to: [to],
        body: input.content,
        idempotencyKey: input.idempotencyKey,
        principalRef,
        ...(input.meta !== undefined ? { meta: { ...input.meta } } : {}),
      })
      const envelope = receipt.envelopes[0]
      return {
        to,
        roomKey: receipt.room.key,
        groupId: receipt.groupId,
        ...(envelope !== undefined ? { envelopeId: envelope.id } : {}),
      }
    } catch (error) {
      // wrkq refuses a replayed idempotency key instead of returning the first
      // receipt. The key is unique to this job run's step attempt, so a refusal
      // means a crashed earlier attempt already delivered this prompt.
      if (isIdempotencyReplay(error)) {
        return { to, replayed: true }
      }
      throw error
    }
  }
}

/** `agent:fettle:project:acp:task:T-1` + `main` → `fettle@acp:T-1`. */
export function ledgerSeatHandle(scopeRef: string, laneRef: string): string {
  if (laneRef !== 'main') {
    throw new Error(
      `agent-dispatch delivers through the collaboration ledger, which addresses seats only on lane main: ${scopeRef} lane ${laneRef}`
    )
  }
  return formatScopeHandle(parseScopeRef(scopeRef))
}

function isIdempotencyReplay(error: unknown): boolean {
  return error instanceof Error && /envelopes_idempotency_idx/.test(error.message)
}
