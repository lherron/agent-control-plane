const DEFAULT_TASKBOARD_BASE_URL = 'http://max3.tail53cc3b.ts.net:18450'

function taskboardBaseUrl(): string {
  const configured =
    process.env['ACP_TASKBOARD_BASE_URL'] ??
    process.env['TASKBOARD_PUBLIC_BASE_URL'] ??
    DEFAULT_TASKBOARD_BASE_URL
  return configured.replace(/\/+$/, '')
}

export function taskboardTaskUrl(projectId: string, taskId: string): string {
  return `${taskboardBaseUrl()}/inbox-hub/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`
}

export function taskboardTerminalFocusUrl(taskId: string): string {
  return `${taskboardBaseUrl()}/focus/${encodeURIComponent(taskId)}`
}

export function isTaskboardTaskId(value: string): boolean {
  return /^T-\d+/.test(value)
}
