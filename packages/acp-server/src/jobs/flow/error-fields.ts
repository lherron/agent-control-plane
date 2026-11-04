// Readers for the loosely typed error shapes thrown by HRC, dispatch and fetch.

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
