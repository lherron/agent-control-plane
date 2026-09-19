import type { InjectionDispatchOptions, InjectionDispatchResult } from 'hrc-injector-core'

/**
 * `enqueue(wait=false)` may return `completed` when the target accepted and
 * completed the notification before its dispatch response crossed the socket.
 * The extracted kicker predates that response shape and treated it as a failed
 * start, leaving the same durable sender-failure notice due forever. This
 * adapter has the only safe discriminator: system notice submissions have no
 * envelope id, unlike normal mail delivery.
 */
export function normalizeFailureNoticeDispatchResult(
  result: InjectionDispatchResult,
  options: InjectionDispatchOptions
): InjectionDispatchResult {
  const dispatch = result as InjectionDispatchResult & { status?: unknown }
  if (
    options.submissionOrigin.principalRef === 'system:hrc-kicker' &&
    options.submissionOrigin.envelopeId === undefined &&
    dispatch.status === 'completed'
  ) {
    return { ...dispatch, status: 'started' } as InjectionDispatchResult
  }
  return result
}
