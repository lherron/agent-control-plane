import { describe, expect, test } from 'bun:test'

import { runCli } from '../cli-test-helpers.js'

type FetchCall = {
  url: string
  method: string
  body: unknown
}

function projectResponse(defaultAgentId: string | undefined) {
  return {
    project: {
      projectId: 'agent-spaces',
      displayName: 'Agent Spaces',
      ...(defaultAgentId !== undefined ? { defaultAgentId } : {}),
    },
  }
}

function interactResponse() {
  return {
    sessionId: 'hsid-interact-1',
    runtimeId: 'rt-interact-1',
    attachDescriptor: {
      transport: 'tmux',
      argv: ['true'],
      bindingFence: {
        hostSessionId: 'hsid-interact-1',
        runtimeId: 'rt-interact-1',
        generation: 1,
      },
    },
  }
}

function supervisorResponse(taskId = 'T-24680') {
  return {
    task: {
      taskId,
      state: { status: 'open', phase: 'todo' },
      version: 0,
    },
    supervisorRun: { runId: 'supv-create-1', contextHash: 'sha256:context' },
    context: {},
  }
}

function parseRequest(input: Request | string | URL, init?: RequestInit): FetchCall {
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function projectEnv(): NodeJS.ProcessEnv {
  return { ASP_PROJECT: 'agent-spaces' }
}

describe('workflow interact CLI', () => {
  test('open-ended invocation resolves default supervisor and posts an unthreaded interact run', async () => {
    const calls: FetchCall[] = []
    const result = await runCli(['--server', 'http://acp.test', 'workflow', 'interact'], {
      env: projectEnv(),
      fetchImpl: async (input, init) => {
        const call = parseRequest(input, init)
        calls.push(call)
        if (call.url === 'http://acp.test/v1/admin/projects/agent-spaces') {
          return jsonResponse(projectResponse('supervisor'))
        }
        if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
          return jsonResponse(interactResponse(), 201)
        }
        throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', 'http://acp.test/v1/admin/projects/agent-spaces'],
      ['POST', 'http://acp.test/v1/workflow-interact-runs'],
    ])
    expect(calls[1]?.body).toMatchObject({
      sessionRef: {
        scopeRef: 'agent:supervisor:project:agent-spaces',
        laneRef: 'lane:main',
      },
      workflowInteract: true,
    })
    expect(JSON.stringify(calls[1]?.body)).not.toContain(':thread:')
    expect(calls[1]?.body).not.toHaveProperty('workflowTaskId')
  })

  test('bare task positional scopes the supervisor session to that workflow task', async () => {
    const calls: FetchCall[] = []
    const result = await runCli(
      ['--server', 'http://acp.test', 'workflow', 'interact', 'T-12345', '--detach'],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          calls.push(call)
          if (call.url === 'http://acp.test/v1/admin/projects/agent-spaces') {
            return jsonResponse(projectResponse('supervisor'))
          }
          if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
            return jsonResponse(interactResponse(), 201)
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(calls[1]?.body).toMatchObject({
      sessionRef: {
        scopeRef: 'agent:supervisor:project:agent-spaces:task:T-12345',
        laneRef: 'lane:main',
      },
      workflowInteract: true,
      workflowTaskId: 'T-12345',
    })
  })

  test('explicit supervisor target positional uses the same task thread shape', async () => {
    const calls: FetchCall[] = []
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'workflow',
        'interact',
        'supervisor@agent-spaces:T-12345',
        '--detach',
      ],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          calls.push(call)
          if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
            return jsonResponse(interactResponse(), 201)
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      sessionRef: {
        scopeRef: 'agent:supervisor:project:agent-spaces:task:T-12345',
        laneRef: 'lane:main',
      },
      workflowInteract: true,
      workflowTaskId: 'T-12345',
    })
  })

  test('create-and-interact creates a workflow task before launching the interactive run', async () => {
    const calls: FetchCall[] = []
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'workflow',
        'interact',
        '--supervisor',
        'supervisor@agent-spaces',
        '--workflow',
        'code_feature_tdd@1',
        '--goal',
        'Implement X',
        '--bind',
        'implementer=larry',
        '--detach',
      ],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          calls.push(call)
          if (call.url === 'http://acp.test/v1/workflow-supervisor-runs') {
            return jsonResponse(supervisorResponse('T-24680'), 201)
          }
          if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
            return jsonResponse(interactResponse(), 201)
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'http://acp.test/v1/workflow-supervisor-runs'],
      ['POST', 'http://acp.test/v1/workflow-interact-runs'],
    ])
    expect(calls[0]?.body).toMatchObject({
      createTask: {
        projectId: 'agent-spaces',
        workflow: { id: 'code_feature_tdd', version: 1 },
        goal: 'Implement X',
        roleBindings: {
          implementer: { kind: 'agent', id: 'larry' },
        },
      },
    })
    expect(calls[1]?.body).toMatchObject({
      sessionRef: {
        scopeRef: 'agent:supervisor:project:agent-spaces:task:T-24680',
        laneRef: 'lane:main',
      },
      workflowInteract: true,
      workflowTaskId: 'T-24680',
      workflowRef: { id: 'code_feature_tdd', version: 1 },
      workflowGoal: 'Implement X',
    })
  })

  test('--supervisor overrides project-default lookup', async () => {
    const calls: FetchCall[] = []
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'workflow',
        'interact',
        'T-12345',
        '--supervisor',
        'reviewer@agent-spaces',
        '--detach',
      ],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          calls.push(call)
          if (call.url.includes('/v1/admin/projects/')) {
            throw new Error('project default lookup should be skipped')
          }
          if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
            return jsonResponse(interactResponse(), 201)
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      sessionRef: {
        scopeRef: 'agent:reviewer:project:agent-spaces:task:T-12345',
        laneRef: 'lane:main',
      },
      workflowTaskId: 'T-12345',
    })
  })

  test('missing project default supervisor fails clearly when no supervisor override is provided', async () => {
    const result = await runCli(
      ['--server', 'http://acp.test', 'workflow', 'interact', '--detach'],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          if (call.url === 'http://acp.test/v1/admin/projects/agent-spaces') {
            return jsonResponse(projectResponse(undefined))
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      'no default supervisor agent configured for project agent-spaces'
    )
  })

  test('--detach skips attach and prints attach information', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'workflow',
        'interact',
        'T-12345',
        '--supervisor',
        'supervisor@agent-spaces',
        '--detach',
      ],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
            return jsonResponse(interactResponse(), 201)
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('agent:supervisor:project:agent-spaces:task:T-12345')
    expect(result.stdout).toContain('rt-interact-1')
    expect(result.stdout).toContain('true')
  })

  test('--json emits the workflow-interact response without attaching', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'workflow',
        'interact',
        'T-12345',
        '--supervisor',
        'supervisor@agent-spaces',
        '--json',
      ],
      {
        env: projectEnv(),
        fetchImpl: async (input, init) => {
          const call = parseRequest(input, init)
          if (call.url === 'http://acp.test/v1/workflow-interact-runs') {
            return jsonResponse(interactResponse(), 201)
          }
          throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(interactResponse())
  })
})
