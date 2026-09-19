import type { HrcClient } from 'hrc-sdk'

import { MAIL_SUBSCRIBER_NAME, createSocketInjectionPort } from './socket-injection-port.js'

/**
 * Exercise the two public capabilities the injector needs before it can own a
 * delivery loop: the evidence head and its durable named broker subscriber.
 * Call this against a real HRC Unix socket during release validation.
 */
export async function verifyInjectorHrcContract(client: HrcClient): Promise<{
  hrcSeq: number
  brokerCommit: number
  subscriberId: string
}> {
  const port = createSocketInjectionPort(client)
  const head = await port.eventsHead()
  const unsubscribe = await port.subscribeBroker({
    afterCommit: head.brokerCommit,
    onEvent: () => {},
  })
  try {
    const admission = (await client.getSubscribers()).active.find(
      (candidate) => candidate.name === MAIL_SUBSCRIBER_NAME
    )
    if (admission === undefined) {
      throw new Error(`HRC did not retain the ${MAIL_SUBSCRIBER_NAME} delivery subscriber`)
    }
    return {
      hrcSeq: head.hrcSeq,
      brokerCommit: head.brokerCommit,
      subscriberId: admission.subscriberId,
    }
  } finally {
    await unsubscribe()
  }
}
