import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadJobFile } from '../commands/job-file-loader.js'

describe('loadJobFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'job-file-loader-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('loads a simple job file without flow', () => {
    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        projectId: 'test-project',
        agentId: 'test-agent',
        scopeRef: 'agent:test-agent:project:test-project',
        schedule: { cron: '0 * * * *' },
        input: { content: 'hello' },
      })
    )

    const { body } = loadJobFile(jobFile)
    expect(body).toEqual({
      projectId: 'test-project',
      agentId: 'test-agent',
      scopeRef: 'agent:test-agent:project:test-project',
      schedule: { cron: '0 * * * *' },
      input: { content: 'hello' },
    })
  })

  test('loads a job file with flow but no inputFile', () => {
    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        projectId: 'test-project',
        agentId: 'test-agent',
        scopeRef: 'agent:test-agent:project:test-project',
        schedule: { cron: '0 * * * *' },
        flow: {
          sequence: [{ stepId: 'step-1', input: 'direct input' }],
        },
      })
    )

    const { body } = loadJobFile(jobFile)
    expect(body).toMatchObject({
      flow: {
        sequence: [{ stepId: 'step-1', input: 'direct input' }],
      },
    })
  })

  test('resolves inputFile in flow.sequence relative to job file dir', () => {
    const inputContent = 'prompt text from file'
    const inputFile = join(tempDir, 'prompt.txt')
    writeFileSync(inputFile, inputContent)

    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        projectId: 'test-project',
        agentId: 'test-agent',
        scopeRef: 'agent:test-agent:project:test-project',
        schedule: { cron: '0 * * * *' },
        flow: {
          sequence: [{ stepId: 'step-1', inputFile: 'prompt.txt' }],
        },
      })
    )

    const { body } = loadJobFile(jobFile)
    const flow = body['flow'] as Record<string, unknown>
    const steps = flow['sequence'] as Record<string, unknown>[]
    expect(steps[0]['input']).toBe(inputContent)
    expect(steps[0]['inputFile']).toBeUndefined()
  })

  test('resolves inputFile in flow.onFailure relative to job file dir', () => {
    const inputContent = 'failure handler input'
    const inputFile = join(tempDir, 'fail.txt')
    writeFileSync(inputFile, inputContent)

    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        projectId: 'test-project',
        agentId: 'test-agent',
        scopeRef: 'agent:test-agent:project:test-project',
        schedule: { cron: '0 * * * *' },
        flow: {
          sequence: [{ stepId: 'step-1', input: 'main' }],
          onFailure: [{ stepId: 'fail-1', inputFile: 'fail.txt' }],
        },
      })
    )

    const { body } = loadJobFile(jobFile)
    const flow = body['flow'] as Record<string, unknown>
    const steps = flow['onFailure'] as Record<string, unknown>[]
    expect(steps[0]['input']).toBe(inputContent)
    expect(steps[0]['inputFile']).toBeUndefined()
  })

  test('resolves inputFile in subdirectory relative to job file dir', () => {
    const subDir = join(tempDir, 'prompts')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 'step.txt'), 'subdir content')

    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        projectId: 'test-project',
        agentId: 'test-agent',
        scopeRef: 'agent:test-agent:project:test-project',
        schedule: { cron: '0 * * * *' },
        flow: {
          sequence: [{ stepId: 'step-1', inputFile: 'prompts/step.txt' }],
        },
      })
    )

    const { body } = loadJobFile(jobFile)
    const flow = body['flow'] as Record<string, unknown>
    const steps = flow['sequence'] as Record<string, unknown>[]
    expect(steps[0]['input']).toBe('subdir content')
    expect(steps[0]['inputFile']).toBeUndefined()
  })

  test('errors when job file does not exist', () => {
    expect(() => loadJobFile(join(tempDir, 'missing.json'))).toThrow(/failed to read job file/)
  })

  test('errors when job file is not valid JSON', () => {
    const jobFile = join(tempDir, 'bad.json')
    writeFileSync(jobFile, 'not json {{{')

    expect(() => loadJobFile(jobFile)).toThrow(/not valid JSON/)
  })

  test('errors when job file is a JSON array', () => {
    const jobFile = join(tempDir, 'arr.json')
    writeFileSync(jobFile, '[]')

    expect(() => loadJobFile(jobFile)).toThrow(/must contain a JSON object/)
  })

  test('errors when inputFile path does not exist', () => {
    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        flow: {
          sequence: [{ stepId: 'step-1', inputFile: 'nonexistent.txt' }],
        },
      })
    )

    expect(() => loadJobFile(jobFile)).toThrow(/failed to read inputFile/)
  })

  test('errors when inputFile is empty string', () => {
    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        flow: {
          sequence: [{ stepId: 'step-1', inputFile: '' }],
        },
      })
    )

    expect(() => loadJobFile(jobFile)).toThrow(/inputFile must be a non-empty string/)
  })

  test('preserves other step fields when resolving inputFile', () => {
    const inputFile = join(tempDir, 'data.txt')
    writeFileSync(inputFile, 'resolved content')

    const jobFile = join(tempDir, 'job.json')
    writeFileSync(
      jobFile,
      JSON.stringify({
        flow: {
          sequence: [
            {
              stepId: 'step-1',
              inputFile: 'data.txt',
              agentId: 'worker',
              retries: 3,
            },
          ],
        },
      })
    )

    const { body } = loadJobFile(jobFile)
    const flow = body['flow'] as Record<string, unknown>
    const steps = flow['sequence'] as Record<string, unknown>[]
    expect(steps[0]).toEqual({
      stepId: 'step-1',
      input: 'resolved content',
      agentId: 'worker',
      retries: 3,
    })
  })
})
