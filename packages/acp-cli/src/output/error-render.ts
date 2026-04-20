import type { AcpErrorBody } from '../http-client.js'

export function renderError(body: AcpErrorBody): string {
  const lines = [`acp: ${body.error.message} [${body.error.code}]`]
  if (body.error.details !== undefined) {
    lines.push(`details: ${JSON.stringify(body.error.details)}`)
  }
  return lines.join('\n')
}
