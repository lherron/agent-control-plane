import { CliUsageError } from './cli-runtime.js'

export type ArgSpec = {
  booleanFlags?: readonly string[] | undefined
  stringFlags?: readonly string[] | undefined
  multiStringFlags?: readonly string[] | undefined
}

export type ParsedArgs = {
  positionals: string[]
  booleanFlags: Set<string>
  stringFlags: Readonly<Record<string, string>>
  multiStringFlags: Readonly<Record<string, string[]>>
}

function canonicalFlag(flag: string): string {
  return flag === '-h' ? '--help' : flag
}

function readFlagValue(
  args: string[],
  index: number,
  flag: string
): { value: string; nextIndex: number } {
  const token = args[index]
  if (token?.startsWith(`${flag}=`)) {
    return {
      value: token.slice(flag.length + 1),
      nextIndex: index,
    }
  }

  const value = args[index + 1]
  if (value === undefined) {
    throw new CliUsageError(`${flag} requires a value`)
  }

  return { value, nextIndex: index + 1 }
}

export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
  const booleanFlags = new Set([...(spec.booleanFlags ?? []), '--help', '-h'])
  const stringFlags = new Set(spec.stringFlags ?? [])
  const multiStringFlags = new Set(spec.multiStringFlags ?? [])

  const seenBooleans = new Set<string>()
  const singleValues = new Map<string, string>()
  const multiValues = new Map<string, string[]>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined) {
      continue
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    if (token === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }

    const flagName = canonicalFlag(token.includes('=') ? token.slice(0, token.indexOf('=')) : token)

    if (booleanFlags.has(flagName)) {
      if (token.includes('=')) {
        throw new CliUsageError(`${flagName} does not take a value`)
      }
      seenBooleans.add(flagName)
      continue
    }

    if (stringFlags.has(flagName)) {
      if (singleValues.has(flagName)) {
        throw new CliUsageError(`${flagName} may only be provided once`)
      }
      const { value, nextIndex } = readFlagValue(args, index, flagName)
      singleValues.set(flagName, value)
      index = nextIndex
      continue
    }

    if (multiStringFlags.has(flagName)) {
      const { value, nextIndex } = readFlagValue(args, index, flagName)
      const existing = multiValues.get(flagName) ?? []
      existing.push(value)
      multiValues.set(flagName, existing)
      index = nextIndex
      continue
    }

    throw new CliUsageError(`unknown flag: ${flagName}`)
  }

  return {
    positionals,
    booleanFlags: seenBooleans,
    stringFlags: Object.fromEntries(singleValues),
    multiStringFlags: Object.fromEntries(multiValues),
  }
}

export function hasFlag(parsed: ParsedArgs, flag: string): boolean {
  return parsed.booleanFlags.has(flag)
}

export function readStringFlag(parsed: ParsedArgs, flag: string): string | undefined {
  return parsed.stringFlags[flag]
}

export function readMultiStringFlag(parsed: ParsedArgs, flag: string): string[] {
  return parsed.multiStringFlags[flag] ?? []
}

export function requireStringFlag(parsed: ParsedArgs, flag: string): string {
  const value = readStringFlag(parsed, flag)
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(`${flag} is required`)
  }
  return value.trim()
}

export function requireNoPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`unexpected positional arguments: ${parsed.positionals.join(' ')}`)
  }
}

export function parseIntegerValue(flag: string, raw: string, options: { min: number }): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < options.min) {
    throw new CliUsageError(`${flag} must be an integer >= ${options.min}`)
  }
  return value
}

export function parseJsonObject(flag: string, raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CliUsageError(`${flag} must be valid JSON`)
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${flag} must be a JSON object`)
  }

  return value as Record<string, unknown>
}

export function parseCommaList(raw: string, flag: string): string[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (values.length === 0) {
    throw new CliUsageError(`${flag} requires at least one value`)
  }

  return values
}
