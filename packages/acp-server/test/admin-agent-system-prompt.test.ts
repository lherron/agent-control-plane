import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin agent system prompt endpoint', () => {
  test('GET /v1/admin/agents/:agentId/system-prompt returns sectioned constructed prompt', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'acp-agent-system-prompt-'))
    const agentsRoot = join(tempRoot, 'agents')
    const agentRoot = join(agentsRoot, 'larry')
    const projectRoot = join(tempRoot, 'project')

    try {
      await mkdir(agentRoot, { recursive: true })
      await mkdir(projectRoot, { recursive: true })
      await writeFile(join(projectRoot, 'README.md'), 'Project docs', 'utf8')
      await writeFile(
        join(agentsRoot, 'context-template.toml'),
        `
schema_version = 2
mode = "append"

[[prompt]]
name = "identity"
type = "inline"
content = "Agent {{agent_name}} on {{project_id}}"

[[prompt]]
name = "project-readme"
type = "file"
path = "project-root:///README.md"

[[prompt]]
name = "heartbeat"
type = "inline"
content = "heartbeat only"
when = { runMode = "heartbeat" }

[[reminder]]
name = "note"
type = "inline"
content = "Stay focused"
`,
        'utf8'
      )

      await withWiredServer(async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/agents',
          body: {
            agentId: 'larry',
            displayName: 'Larry',
            homeDir: agentRoot,
            status: 'active',
            actor: { kind: 'agent', id: 'operator' },
          },
        })
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/projects',
          body: {
            projectId: 'agent-spaces',
            displayName: 'Agent Spaces',
            homeDir: projectRoot,
            actor: { kind: 'agent', id: 'operator' },
          },
        })

        const response = await fixture.request({
          method: 'GET',
          path: '/v1/admin/agents/larry/system-prompt?runMode=query&projectId=agent-spaces',
        })
        expect(response.status).toBe(200)
        const payload = await fixture.json<{
          systemPrompt: {
            template: { kind: string; path: string; mode: string }
            prompt: {
              content: string
              mode: string
              sections: Array<{
                name: string
                included: boolean
                content?: string
                skippedReason?: string
              }>
            }
            reminder: { content: string }
          }
        }>(response)

        expect(payload.systemPrompt.template).toEqual(
          expect.objectContaining({
            kind: 'context',
            path: join(agentsRoot, 'context-template.toml'),
            mode: 'append',
          })
        )
        expect(payload.systemPrompt.prompt.mode).toBe('append')
        expect(payload.systemPrompt.prompt.content).toContain('Agent larry on agent-spaces')
        expect(payload.systemPrompt.prompt.content).toContain('Project docs')
        expect(
          payload.systemPrompt.prompt.sections.find((section) => section.name === 'identity')
        ).toEqual(
          expect.objectContaining({
            included: true,
            content: 'Agent larry on agent-spaces',
          })
        )
        expect(
          payload.systemPrompt.prompt.sections.find((section) => section.name === 'heartbeat')
        ).toEqual(
          expect.objectContaining({
            included: false,
            skippedReason: 'when',
          })
        )
        expect(payload.systemPrompt.reminder.content).toBe('Stay focused')
      })
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
