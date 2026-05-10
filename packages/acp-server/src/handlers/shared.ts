import type { Task } from 'acp-core'
import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'

import { badRequest, notFound } from '../http.js'
import {
  readOptionalRecordField,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'

export function requireTaskId(params: Record<string, string>): string {
  const taskId = params['taskId']
  if (taskId === undefined || taskId.length === 0) {
    badRequest('taskId route param is required', { field: 'taskId' })
  }

  return taskId
}

export function requireRunId(params: Record<string, string>): string {
  const runId = params['runId']
  if (runId === undefined || runId.length === 0) {
    badRequest('runId route param is required', { field: 'runId' })
  }

  return runId
}

export function requireTask(task: Task | undefined, taskId: string): Task {
  if (task === undefined) {
    notFound(`task not found: ${taskId}`, { taskId })
  }

  return task
}

export function parseSessionRefField(input: Record<string, unknown>, field: string): SessionRef {
  const raw = requireRecord(input[field], field)
  const laneRef = readOptionalTrimmedStringField(raw, 'laneRef')

  return normalizeSessionRef({
    scopeRef: requireTrimmedStringField(raw, 'scopeRef'),
    ...(laneRef !== undefined ? { laneRef } : {}),
  })
}

export function taskIdFromSessionRef(sessionRef: SessionRef): string | undefined {
  const parsed = parseScopeRef(sessionRef.scopeRef)
  return parsed.taskId
}

export function readOptionalMeta(
  input: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  return readOptionalRecordField(input, 'meta')
}
