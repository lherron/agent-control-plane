import { AcpClientHttpError, AcpClientTransportError, isAcpErrorBody } from './http-client.js'
import { renderError } from './output/error-render.js'

export type CommandOutput =
  | {
      format: 'json'
      body: unknown
    }
  | {
      format: 'text'
      text: string
    }

export class CliUsageError extends Error {
  readonly exitCode = 1

  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export class CliServerError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'CliServerError'
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function printText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function printError(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function writeCommandOutput(output: CommandOutput): void {
  if (output.format === 'json') {
    printJson(output.body)
    return
  }

  printText(output.text)
}

export function exitWithError(error: unknown, options: { json: boolean }): never {
  if (error instanceof CliUsageError) {
    printError(`acp: ${error.message}`)
    process.exit(error.exitCode)
  }

  if (error instanceof AcpClientTransportError || error instanceof CliServerError) {
    printError(`acp: ${error.message}`)
    process.exit(2)
  }

  if (error instanceof AcpClientHttpError) {
    if (options.json && error.body !== undefined) {
      printError(typeof error.body === 'string' ? error.body : JSON.stringify(error.body, null, 2))
    } else if (isAcpErrorBody(error.body)) {
      printError(renderError(error.body))
    } else {
      printError(`acp: ${error.message}`)
    }

    process.exit(error.status >= 500 ? 2 : 1)
  }

  if (error instanceof Error) {
    printError(`acp: ${error.message}`)
    process.exit(2)
  }

  printError(`acp: ${String(error)}`)
  process.exit(2)
}
