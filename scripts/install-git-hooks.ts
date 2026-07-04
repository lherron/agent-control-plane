#!/usr/bin/env bun
import { constants, accessSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

function run(command: string[], cwd?: string): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
    exitCode: result.exitCode,
  }
}

function fail(message: string): never {
  console.error(`ACP hook install error: ${message}`)
  process.exit(1)
}

const gitRoot = run(['git', 'rev-parse', '--show-toplevel'])
if (gitRoot.exitCode !== 0 || gitRoot.stdout.length === 0) {
  fail(gitRoot.stderr || 'not inside a Git worktree')
}

const repoRoot = gitRoot.stdout
const hooksPath = '.githooks'
const requiredHooks = ['pre-commit', 'pre-push']

for (const hook of requiredHooks) {
  const hookPath = join(repoRoot, hooksPath, hook)

  try {
    const stat = statSync(hookPath)
    if (!stat.isFile()) {
      fail(`${relative(repoRoot, hookPath)} exists but is not a file`)
    }
    accessSync(hookPath, constants.X_OK)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`${relative(repoRoot, hookPath)} is missing or not executable: ${detail}`)
  }
}

const setHooksPath = run(['git', 'config', '--local', 'core.hooksPath', hooksPath], repoRoot)
if (setHooksPath.exitCode !== 0) {
  fail(setHooksPath.stderr || 'git config --local core.hooksPath failed')
}

const configuredHooksPath = run(['git', 'config', '--local', '--get', 'core.hooksPath'], repoRoot)
if (configuredHooksPath.exitCode !== 0 || configuredHooksPath.stdout !== hooksPath) {
  fail(`core.hooksPath is ${configuredHooksPath.stdout || '<unset>'}, expected ${hooksPath}`)
}

console.log(`ACP git hooks materialized: core.hooksPath=${hooksPath}`)
