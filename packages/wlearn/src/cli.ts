#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

import {
  materializeWorkflowTrace,
  runDeterministicWorkflowReplay,
  validatePromotionReadiness,
} from 'acp-core'
import type { ActorRef, PatchBundle, WorkflowKernelSnapshot } from 'acp-core'

function parseArgs(argv: string[]): { command: string[]; flags: Record<string, string> } {
  const command: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token?.startsWith('--') === true) {
      const key = token.slice(2)
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--') === true) {
        throw new Error(`missing value for --${key}`)
      }
      flags[key] = value
      index += 1
    } else if (token !== undefined) {
      command.push(token)
    }
  }
  return { command, flags }
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function parseActor(value: string): ActorRef {
  const [kind, id] = value.split(':')
  if (
    (kind === 'agent' || kind === 'human' || kind === 'service' || kind === 'group') &&
    id !== undefined &&
    id.length > 0
  ) {
    return { kind, id } as ActorRef
  }
  throw new Error(`invalid actor, expected kind:id: ${value}`)
}

function parsePatchBundle(value: string): PatchBundle {
  return JSON.parse(value) as PatchBundle
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const PLAYBOOK_AUTHORITY_TIER = 2
const PATCH_AUTHORITY_TIER = 3

function handleTraceMaterialize(flags: Record<string, string>): void {
  const snapshot = readJsonFile<WorkflowKernelSnapshot>(requireFlag(flags, 'snapshot'))
  const workflowTaskId = requireFlag(flags, 'task')
  printJson(materializeWorkflowTrace({ snapshot, workflowTaskId }))
}

function handleReplayRun(flags: Record<string, string>): void {
  const snapshot = readJsonFile<WorkflowKernelSnapshot>(requireFlag(flags, 'snapshot'))
  const workflowTaskId = requireFlag(flags, 'task')
  printJson(
    runDeterministicWorkflowReplay({
      snapshot,
      workflowTaskId,
      ...(flags['candidate'] !== undefined ? { patchBundleId: flags['candidate'] } : {}),
    })
  )
}

function handleHrcSummarizeRange(flags: Record<string, string>): void {
  printJson({
    hrcRunId: requireFlag(flags, 'hrc-run'),
    startSeq: Number(requireFlag(flags, 'start')),
    endSeq: Number(requireFlag(flags, 'end')),
    note: 'HRC range summarization is read-only; provide raw HRC events to downstream summarizers.',
  })
}

function handlePlaybookDraft(flags: Record<string, string>): void {
  printJson({
    artifactKind: 'workflow_playbook',
    authorityTier: PLAYBOOK_AUTHORITY_TIER,
    lifecycle: 'draft',
    sourceTraceIds: [requireFlag(flags, 'trace')],
    guidance: 'Draft guidance must be reviewed in ACP before activation.',
  })
}

function handlePatchDraft(flags: Record<string, string>): void {
  printJson({
    artifactKind: 'patch_bundle',
    authorityTier: PATCH_AUTHORITY_TIER,
    lifecycle: 'draft',
    sourceTraceIds: [requireFlag(flags, 'trace')],
    targetFacet: requireFlag(flags, 'target'),
    note: 'Draft patch bundles require ACP evaluation and promotion workflows.',
  })
}

function handleCurateReport(flags: Record<string, string>): void {
  printJson({
    reportKind: 'curation_report',
    scope: requireFlag(flags, 'scope'),
    actions: [],
    note: 'Curation reports never delete raw ACP/HRC records.',
  })
}

function handlePromotionSubmit(flags: Record<string, string>): void {
  const patchBundle = parsePatchBundle(requireFlag(flags, 'patch-bundle-json'))
  const reviewer = parseActor(requireFlag(flags, 'reviewer'))
  const externalAuthority =
    flags['external-authority'] !== undefined
      ? parseActor(flags['external-authority'] as string)
      : undefined
  const report = validatePromotionReadiness({
    patchBundle,
    replayReportIds: [requireFlag(flags, 'replay-report')],
    evalReportIds: [requireFlag(flags, 'eval-report')],
    promotionReviewer: reviewer,
    ...(externalAuthority !== undefined ? { externalAuthority } : {}),
  })
  printJson({
    report,
    acpAction: 'promotion_requested',
    note: 'wlearn only submits readiness material; ACP owns promotion workflow state.',
  })
}

function usage(): never {
  throw new Error(`usage:
  wlearn trace materialize --snapshot <file> --task <workflowTaskId>
  wlearn replay run --snapshot <file> --task <workflowTaskId> [--candidate <patchBundleId>]
  wlearn hrc summarize-range --hrc-run <id> --start <seq> --end <seq>
  wlearn playbook draft --trace <traceId>
  wlearn patch draft --trace <traceId> --target <facet>
  wlearn curate report --scope <scope>
  wlearn promotion submit --patch-bundle-json <json> --replay-report <id> --eval-report <id> --reviewer <kind:id> [--external-authority <kind:id>]`)
}

export function runWlearnCli(argv = process.argv.slice(2)): void {
  const { command, flags } = parseArgs(argv)
  const key = command.join(' ')

  if (key === 'trace materialize') {
    handleTraceMaterialize(flags)
    return
  }

  if (key === 'replay run') {
    handleReplayRun(flags)
    return
  }

  if (key === 'hrc summarize-range') {
    handleHrcSummarizeRange(flags)
    return
  }

  if (key === 'playbook draft') {
    handlePlaybookDraft(flags)
    return
  }

  if (key === 'patch draft') {
    handlePatchDraft(flags)
    return
  }

  if (key === 'curate report') {
    handleCurateReport(flags)
    return
  }

  if (key === 'promotion submit') {
    handlePromotionSubmit(flags)
    return
  }

  if (key.length === 0 || key === 'help' || flags['help'] === 'true') {
    usage()
  }

  throw new Error(`unknown wlearn command: ${key}`)
}

if (import.meta.main) {
  try {
    runWlearnCli()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
}
