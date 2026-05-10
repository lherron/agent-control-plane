import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CliUsageError } from '../../src/cli-runtime.js'

async function loadCommand(): Promise<{
  runWorkflowPublishCommand(args: string[], deps?: { fetchImpl?: typeof fetch }): Promise<unknown>
}> {
  return import('../../src/commands/workflow-publish.js')
}

const workflow = {
  id: 'publish-cli',
  version: 1,
  kind: 'generic',
  initial: { status: 'open', phase: 'todo' },
  roles: { collector: { binding: 'autoBindOnFirstRun' } },
  evidenceKinds: {},
  transitions: {},
}

describe('acp workflow publish command', () => {
  test('reads a workflow file and POSTs it to /v1/workflows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-workflow-publish-'))
    const file = join(dir, 'workflow.json')
    await writeFile(file, `${JSON.stringify(workflow)}\n`)
    const seen: Array<{ url: string; method?: string; body?: string }> = []
    const { runWorkflowPublishCommand } = await loadCommand()

    await runWorkflowPublishCommand(['--server', 'http://acp.test', file], {
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), method: init?.method, body: String(init?.body) })
        return new Response(JSON.stringify({ definition: { ...workflow, hash: 'sha256:test' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    expect(seen).toEqual([
      {
        url: 'http://acp.test/v1/workflows',
        method: 'POST',
        body: `${JSON.stringify(workflow)}\n`,
      },
    ])
  })

  test('rejects a missing workflow file with CliUsageError', async () => {
    const { runWorkflowPublishCommand } = await loadCommand()

    await expect(
      runWorkflowPublishCommand(['/tmp/acp-workflow-publish-missing.json'])
    ).rejects.toBeInstanceOf(CliUsageError)
  })

  test('rejects invalid JSON files with CliUsageError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-workflow-publish-'))
    const file = join(dir, 'workflow.json')
    await writeFile(file, '{"id":')
    const { runWorkflowPublishCommand } = await loadCommand()

    await expect(runWorkflowPublishCommand([file])).rejects.toBeInstanceOf(CliUsageError)
  })

  test('--json emits the publish response as JSON output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-workflow-publish-'))
    const file = join(dir, 'workflow.json')
    await writeFile(file, JSON.stringify(workflow))
    const { runWorkflowPublishCommand } = await loadCommand()

    const output = await runWorkflowPublishCommand(
      ['--server', 'http://acp.test', '--json', file],
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ definition: { ...workflow, hash: 'sha256:test' } }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      }
    )

    expect(output).toEqual({
      format: 'json',
      body: { definition: { ...workflow, hash: 'sha256:test' } },
    })
  })
})
