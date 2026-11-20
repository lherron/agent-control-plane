import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Dependency injection for tests. Production reads Loggia's config, Loggia's
 * schema in the loggia checkout and the installed `cardo`; none of these is an
 * environment or config knob.
 */
export type PluginPagesOptions = {
  loggiaConfigPath?: string | undefined
  schemaPath?: string | undefined
  cardoBin?: string | undefined
  /** The CLI's default request deadline (cardo T-14122: 60 s). */
  defaultDeadlineSeconds?: number | undefined
  /** How long ACP lets a child outlive the CLI's own deadline before killing it. */
  backstopGraceMs?: number | undefined
}

export type ResolvedPluginPagesOptions = {
  loggiaConfigPath: string
  schemaPath: string
  cardoBin: string
  defaultDeadlineSeconds: number
  backstopGraceMs: number
}

export function resolvePluginPagesOptions(
  options: PluginPagesOptions = {}
): ResolvedPluginPagesOptions {
  const home = homedir()
  return {
    loggiaConfigPath:
      options.loggiaConfigPath ??
      join(home, 'Library', 'Application Support', 'Loggia', 'config.json'),
    schemaPath:
      options.schemaPath ??
      join(home, 'praesidium', 'loggia', 'schemas', 'plugin-mobile.schema.json'),
    // cardo's `just install-cli` installs here; launchd's PATH does not include it.
    cardoBin: options.cardoBin ?? join(home, '.cargo', 'bin', 'cardo'),
    defaultDeadlineSeconds: options.defaultDeadlineSeconds ?? 60,
    backstopGraceMs: options.backstopGraceMs ?? 5_000,
  }
}
