import { isTerminalRuntimeStatus } from 'hrc-core'
import type { HrcRuntimeSnapshot, HrcSessionRecord, SessionPageItem } from 'hrc-core'

import type { AcpHrcClient } from '../deps.js'

/**
 * T-13191: HRC's seat disposition on a mobile session summary, named and
 * valued as HRC serves it. A parked seat keeps status `inactive`; the phone
 * keys on `inactive` plus `disposition: 'parked'`.
 */
export type SessionDisposition = {
  disposition: 'parked' | null
  dispositionAt: string | null
}

const NO_DISPOSITION: SessionDisposition = { disposition: null, dispositionAt: null }

/** A session page item already carries the disposition; older peers omit it. */
export function pageItemDisposition(item: SessionPageItem): SessionDisposition {
  return { disposition: item.disposition ?? null, dispositionAt: item.dispositionAt ?? null }
}

/**
 * A summary built from a plain HrcSessionRecord has no disposition, so read
 * HRC's single-session get. Only a summary going out inactive without a live
 * runtime can be parked, so every other summary costs no read. A failed get
 * answers null rather than holding back the summary.
 */
export async function recordDisposition(
  hrcClient: Pick<AcpHrcClient, 'getSessionByContinuity'>,
  record: Pick<HrcSessionRecord, 'scopeRef' | 'laneRef'>,
  summary: { summaryStatus: string },
  runtime: HrcRuntimeSnapshot | undefined
): Promise<SessionDisposition> {
  if (summary.summaryStatus !== 'inactive') return NO_DISPOSITION
  if (runtime !== undefined && !isTerminalRuntimeStatus(runtime.status)) return NO_DISPOSITION
  try {
    const session = await hrcClient.getSessionByContinuity({
      scopeRef: record.scopeRef,
      laneRef: record.laneRef,
    })
    return {
      disposition: session.disposition ?? null,
      dispositionAt: session.dispositionAt ?? null,
    }
  } catch {
    return NO_DISPOSITION
  }
}
