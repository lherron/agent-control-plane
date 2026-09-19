import { createMailKicker } from 'hrc-mail-kicker'
import type { HrcInjectionPort as KickerInjectionPort } from 'hrc-mail-kicker'
import { HrcClient } from 'hrc-sdk'

import {
  type InjectorStateImport,
  assertInjectorAdmissible,
  createSocketInjectionPort,
  openInjectorStateStore,
  readInjectorImportMarker,
} from 'hrc-injector-core'

import { normalizeFailureNoticeDispatchResult } from './failure-notice-dispatch.js'
import { createWrkqLedger } from './wrkq-ledger.js'

export type MailInjectorOptions = Readonly<{
  socketPath: string
  statePath: string
  importFrom?: InjectorStateImport | undefined
  nodeId: string
  sweepIntervalMs?: number | undefined
  log?: (
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    event: string,
    detail: Record<string, unknown>
  ) => void
}>

export type StartedMailInjector = Readonly<{
  stop(): Promise<void>
  statePath: string
  importMarker: Readonly<{ sourcePath: string; importedAt: string }>
}>

export function assertMailInjectorPosture(
  posture: unknown
): asserts posture is 'disabled' | 'absent' {
  if (posture !== 'disabled' && posture !== 'absent' && posture !== 'in-process') {
    throw new Error('HRC status has no recognized mailKicker delivery posture')
  }
  assertInjectorAdmissible(posture)
}

/**
 * `enqueue(wait=false)` may return `completed` when the target accepted and
 * completed the notification before its dispatch response crossed the socket.
 * The extracted kicker predates that response shape and treated it as a failed
 * start, leaving the same durable sender-failure notice due forever. This
 * adapter has the only safe discriminator: system notice submissions have no
 * envelope id, unlike normal mail delivery.
 */
/**
 * Start the sole external collaboration-mail delivery owner. HRC's status is
 * checked before the state database is opened so an in-process writer can
 * never race this process.
 */
export async function startMailInjector(
  options: MailInjectorOptions
): Promise<StartedMailInjector> {
  const client = new HrcClient(options.socketPath)
  const status = (await client.getStatus()) as unknown as { mailKicker?: unknown }
  assertMailInjectorPosture(status.mailKicker)

  const store = openInjectorStateStore(options.statePath, options.importFrom)
  const importMarker = readInjectorImportMarker(options.statePath, options.importFrom?.sourcePath)
  if (importMarker === undefined) {
    store.close()
    throw new Error('mail injector requires a verified private kicker-store import marker')
  }

  const log = options.log ?? ((level, event, detail) => console.log(level, event, detail))
  const ledger = createWrkqLedger()
  const socketPort = createSocketInjectionPort(client)
  const kicker = createMailKicker(
    {
      store,
      // injector-core deliberately exposes the public response projection;
      // the inherited policy also reads the complete dispatch response. Both
      // are supplied by the same HRC socket implementation at runtime.
      port: {
        ...socketPort,
        enqueue: async (
          session: Parameters<typeof socketPort.enqueue>[0],
          intent: Parameters<typeof socketPort.enqueue>[1],
          prompt: Parameters<typeof socketPort.enqueue>[2],
          options: Parameters<typeof socketPort.enqueue>[3]
        ) =>
          normalizeFailureNoticeDispatchResult(
            await socketPort.enqueue(session, intent, prompt, options),
            options
          ),
      } as unknown as KickerInjectionPort,
      ledger,
      nodeId: options.nodeId,
      foreignHomeMemo: new Map(),
      log,
    },
    { enabled: true, sweepIntervalMs: options.sweepIntervalMs ?? 1_000 }
  )
  try {
    await kicker.start()
  } catch (error) {
    store.close()
    throw error
  }
  return {
    statePath: options.statePath,
    importMarker,
    stop: async () => {
      await kicker.stop()
    },
  }
}
