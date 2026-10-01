import type { WorkClient } from '@wrkq/client'
import type { HrcClient } from 'hrc-sdk'

import type { ReconcilerConfig } from './config.js'
import {
  type ReconcilerReader,
  type ReconcilerWriter,
  createHrcPort,
  createWrkqReader,
  createWrkqWriter,
} from './ports.js'
import { type AcpReconciler, type ReconcilerLog, createReconcilerCore } from './reconciler.js'

export {
  RECONCILER_DEFAULTS,
  RECONCILER_ENV,
  type ReconcilerConfig,
  ReconcilerConfigError,
  readReconcilerConfig,
} from './config.js'
export type { Decision } from './evaluate.js'
export type { ReconcilerReader, ReconcilerWriter } from './ports.js'
export type {
  AcpReconciler,
  ExplainResult,
  ReconcilerLog,
  ScanAction,
  ScanResult,
} from './reconciler.js'

export type AcpReconcilerOptions = Readonly<{
  config: ReconcilerConfig
  /** A wrkq client connected as `config.principalRef`. */
  workClient: WorkClient
  hrcClient?: HrcClient | undefined
  hrcSocketPath?: string | undefined
  log?: ReconcilerLog | undefined
}>

export function createProductionPorts(options: AcpReconcilerOptions): {
  reader: ReconcilerReader
  writer: ReconcilerWriter
} {
  const hrc = createHrcPort({
    principalRef: options.config.principalRef,
    client: options.hrcClient,
    socketPath: options.hrcSocketPath,
  })
  const wrkqReader = createWrkqReader(options.workClient)
  const wrkqWriter = createWrkqWriter(options.workClient, options.config.principalRef)
  return {
    reader: {
      localNodeId: hrc.localNodeId,
      listRequests: wrkqReader.listRequests,
      readFacts: wrkqReader.readFacts,
      holderLiveness: hrc.holderLiveness,
      workerValidity: hrc.workerValidity,
      seatSession: hrc.seatSession,
    },
    writer: {
      postFact: wrkqWriter.postFact,
      notify: wrkqWriter.notify,
      startWorker: hrc.startWorker,
    },
  }
}

/** The host constructs this, then owns start() at startup and stop() at shutdown. */
export function createAcpReconciler(options: AcpReconcilerOptions): AcpReconciler {
  const { reader, writer } = createProductionPorts(options)
  return createReconcilerCore({ config: options.config, reader, writer, log: options.log })
}
