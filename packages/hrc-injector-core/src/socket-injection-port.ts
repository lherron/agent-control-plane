import type {
  HrcBrokerInvocationEventRecord,
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptSubmissionRequest,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type { SubmissionWithdrawResponse } from 'spaces-harness-broker-protocol'

import type {
  ForeignHome,
  HrcInjectionPort,
  InjectionDispatchOptions,
  InjectionDispatchResult,
  InjectionRpcResult,
} from './contracts.js'

export const MAIL_SUBSCRIBER_NAME = 'mail'
const BROKER_FOLLOW_LIMIT = 500
const EMPTY_FOLLOW_DELAY_MS = 100
const RECONNECT_DELAY_MS = 250

/**
 * Socket-only implementation of the injector's HRC capability boundary.
 * Declaring the durable `mail` subscriber is intentionally lazy and idempotent:
 * both evidence feeds use the same admitted consumer identity.
 */
export function createSocketInjectionPort(client: HrcClient): HrcInjectionPort {
  let closed = false
  let subscriber: Promise<void> | undefined
  const declareSubscriber = async (): Promise<void> => {
    const attempt =
      subscriber ?? client.declareSubscriber({ name: MAIL_SUBSCRIBER_NAME }).then(() => undefined)
    subscriber = attempt
    try {
      await attempt
    } catch (error) {
      if (subscriber === attempt) subscriber = undefined
      throw error
    }
  }
  const invalidateSubscriber = (): void => {
    subscriber = undefined
  }

  const targetSession = async (targetSessionRef: string): Promise<HrcSessionRecord | undefined> => {
    const target = (await client.listTargets({ includeDormant: true })).find(
      (candidate) => candidate.sessionRef === targetSessionRef
    )
    return target?.activeHostSessionId === undefined
      ? undefined
      : await client.getSession(target.activeHostSessionId)
  }

  const dispatch = async (
    door: 'steer' | 'enqueue' | 'invoke' | 'preempt',
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: InjectionDispatchOptions
  ): Promise<InjectionDispatchResult> => {
    const target = `${session.scopeRef}/lane:${session.laneRef}`
    const origin = options.submissionOrigin
    if (door === 'steer') {
      return await client.steer({
        target,
        body: prompt,
        origin,
        wait: options.waitForCompletion,
      })
    }
    if (door === 'enqueue') {
      return await client.enqueue({
        target,
        body: prompt,
        origin,
        runtimeIntent: intent,
        ttlMs: options.ttlMs,
        turnPolicy: options.turnPolicy,
        wait: options.waitForCompletion,
      })
    }
    if (door === 'invoke') {
      return await client.invoke({
        target,
        body: prompt,
        origin,
        runtimeIntent: intent,
        ttlMs: options.ttlMs,
        turnPolicy: options.turnPolicy,
        wait: options.waitForCompletion,
        ...(options.launchPromptOnColdBirth
          ? { coldBirth: { promptMode: 'replace-priming' as const } }
          : {}),
      })
    }
    return await client.preempt({
      target,
      body: prompt,
      origin,
      runtimeIntent: intent,
      ttlMs: options.ttlMs,
      turnPolicy: options.turnPolicy,
      wait: options.waitForCompletion,
    })
  }

  const nonLocalHome = async (scopeRef: string): Promise<ForeignHome | undefined> => {
    const location = await client.locateScope(scopeRef)
    const authority = location.authority
    return authority.state !== 'bound' || authority.isLocal
      ? undefined
      : {
          homeNodeId: authority.record.homeNodeId,
          source: authority.source === 'ledger' ? 'placement-ledger' : 'registry',
        }
  }

  const port: HrcInjectionPort = {
    runtime: async (runtimeId) =>
      (await client.listRuntimes({ all: true })).find((runtime) => runtime.runtimeId === runtimeId),
    runtimesByHostSession: async (hostSessionId) =>
      await client.listRuntimes({ hostSessionId, all: true }),
    allRuntimes: async () => await client.listRuntimes({ all: true }),
    liveSessionRefs: async () =>
      (await client.getLiveSeatRefs()).refs.map((ref) => `${ref.scopeRef}/lane:${ref.laneRef}`),
    seat: async (runtimeId) => await client.getSeat(runtimeId),
    withdraw: async (input): Promise<InjectionRpcResult<SubmissionWithdrawResponse>> => {
      try {
        const response = await client.withdraw(input)
        return {
          ok: true,
          response:
            response.outcome === 'withdrawn'
              ? { outcome: 'withdrawn' }
              : response.outcome === 'unknown'
                ? { outcome: 'unknown' }
                : { outcome: 'not_held', state: response.state ?? 'terminal' },
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    },
    resolveForeignHome: nonLocalHome,
    resolveRuntimeIntent: async (scopeRef, materializationIntent) =>
      (await client.resolveRuntimeIntent({ scopeRef, materializationIntent })).intent,
    targetBySessionRef: targetSession,
    ensureTargetSession: async (targetSessionRef, intent, options) => {
      const target = await client.ensureTarget({
        sessionRef: targetSessionRef,
        runtimeIntent: intent,
        persistIntent: options.persistIntent,
      })
      if (target.activeHostSessionId === undefined) {
        throw new Error(`HRC target ${targetSessionRef} did not materialize a session`)
      }
      return await client.getSession(target.activeHostSessionId)
    },
    eventsHead: async () => await client.eventsHead(),
    lifecycleEvents: async ({ eventKind, runtimeId, limit }) =>
      (await client.tailEvents({ limit, eventKind, runtimeId })).events,
    brokerEventsQuery: async (op) => await client.queryBrokerEvents(op),
    localPlacementBindings: async () => await client.listLocalPlacementBindings(),
    locate: nonLocalHome,
    unbornDesignations: async () => await client.listUnbornDesignations(),
    subscribeLifecycle: async ({ afterSeq, onEvent }) => {
      await declareSubscriber()
      const operation = (async () => {
        let cursor = afterSeq
        while (!closed) {
          try {
            await declareSubscriber()
            let observed = false
            for await (const event of client.watch({ fromSeq: cursor + 1 })) {
              if (closed) return
              observed = true
              cursor = event.hrcSeq
              onEvent(event)
            }
            // A watch normally ends only when its daemon-side stream closes.
            // The replacement daemon has no in-memory named subscribers, so
            // force the next iteration to declare this consumer again.
            invalidateSubscriber()
            if (!closed) {
              await delay(observed ? RECONNECT_DELAY_MS : EMPTY_FOLLOW_DELAY_MS)
            }
          } catch {
            invalidateSubscriber()
            if (!closed) await delay(RECONNECT_DELAY_MS)
          }
        }
      })()
      return async () => {
        closed = true
        await operation
      }
    },
    subscribeBroker: async ({ afterCommit, onEvent }) => {
      await declareSubscriber()
      const operation = (async () => {
        let cursor = afterCommit
        while (!closed) {
          try {
            await declareSubscriber()
            const page = await client.followBrokerEvents(
              { afterCommit: cursor, limit: BROKER_FOLLOW_LIMIT },
              MAIL_SUBSCRIBER_NAME
            )
            for (const event of page.events) {
              if (closed) return
              onEvent({
                ...event,
                id: event.commitOrdinal,
              } as HrcBrokerInvocationEventRecord)
            }
            cursor = page.nextCommit
            if (page.events.length === 0) await delay(EMPTY_FOLLOW_DELAY_MS)
          } catch {
            // HRC subscriber declarations are daemon-memory state. A socket
            // break or an unknown-subscriber response after daemon restart
            // invalidates the successful declaration from the prior epoch.
            invalidateSubscriber()
            if (!closed) await delay(RECONNECT_DELAY_MS)
          }
        }
      })()
      return async () => {
        closed = true
        await operation
      }
    },
    steer: (session, intent, prompt, options) =>
      dispatch('steer', session, intent, prompt, options),
    enqueue: (session, intent, prompt, options) =>
      dispatch('enqueue', session, intent, prompt, options),
    invoke: (session, intent, prompt, options) =>
      dispatch('invoke', session, intent, prompt, options),
    preempt: (session, intent, prompt, options) =>
      dispatch('preempt', session, intent, prompt, options),
    preemptAdmission: async (_session, request: PreemptSubmissionRequest) =>
      (await client.preemptAdmission(request)).admission,
  }
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (closed) return Promise.reject(new Error('socket injection port is stopped'))
        return Reflect.apply(value, target, args)
      }
    },
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
