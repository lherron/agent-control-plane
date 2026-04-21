import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectAcpServerStatus,
  formatAcpServerStatus,
  renderServerHelp,
  resolveAcpServerPaths,
} from '../src/server-runtime.js'

describe('acp server runtime', () => {
  const originalRuntimeDir = process.env.ACP_RUNTIME_DIR
  const originalLogPath = process.env.ACP_LOG_PATH
  const originalPort = process.env.ACP_PORT
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
    if (originalRuntimeDir === undefined) {
      process.env.ACP_RUNTIME_DIR = undefined
    } else {
      process.env.ACP_RUNTIME_DIR = originalRuntimeDir
    }
    if (originalPort === undefined) {
      process.env.ACP_PORT = undefined
    } else {
      process.env.ACP_PORT = originalPort
    }
    if (originalLogPath === undefined) {
      process.env.ACP_LOG_PATH = undefined
    } else {
      process.env.ACP_LOG_PATH = originalLogPath
    }
  })

  test('resolves ACP daemon paths from ACP_RUNTIME_DIR', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-server-runtime-'))
    process.env.ACP_RUNTIME_DIR = tempDir
    process.env.ACP_LOG_PATH = join(tempDir, 'server.log')

    expect(resolveAcpServerPaths()).toEqual({
      runtimeRoot: tempDir,
      pidPath: join(tempDir, 'server.pid'),
      logPath: join(tempDir, 'server.log'),
    })
  })

  test('reports a down endpoint without requiring ACP_WRKQ_DB_PATH', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-server-status-'))
    process.env.ACP_RUNTIME_DIR = tempDir
    process.env.ACP_PORT = '65534'

    const status = await collectAcpServerStatus()

    expect(status.running).toBe(false)
    expect(status.endpoint).toBe('http://127.0.0.1:65534')
    expect(formatAcpServerStatus(status)).toContain('ACP Server Status')
  })

  test('documents the combined HTTP plus Discord process surface', () => {
    expect(renderServerHelp()).toContain('acp server serve')
    expect(renderServerHelp()).toContain('--no-discord')
  })
})
