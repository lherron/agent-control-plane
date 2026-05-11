#!/usr/bin/env bun
import { runWlearnCli } from '../src/cli.ts'

try {
  runWlearnCli()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
