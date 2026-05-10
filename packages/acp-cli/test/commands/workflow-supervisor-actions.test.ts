import { describe, expect, test } from 'bun:test'

import { runWorkflowActionCommand } from '../../src/commands/workflow-action.js'

describe('workflow supervisor action CLI', () => {
  test('forwards new supervisor action types without request-body capabilities', async () => {
    const seen: Array<{ body: unknown }> = []
    const fetchImpl = async (_input: Request | string | URL, init?: RequestInit) => {
      seen.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return new Response(
        JSON.stringify({
          task: {
            taskId: 'T-01396',
            state: { status: 'active', phase: 'doing' },
            version: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    await runWorkflowActionCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--task',
        'T-01396',
        '--supervisor-run',
        'supervisor-run-1',
        '--action',
        '{"type":"attach_evidence","evidence":[{"kind":"completion_note","ref":"artifact://note","summary":"done"}]}',
        '--capabilities',
        '{"attachEvidence":true}',
        '--idempotency-key',
        'cli-supervisor-actions:attach',
      ],
      { fetchImpl }
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toEqual({
      supervisorRunId: 'supervisor-run-1',
      action: {
        type: 'attach_evidence',
        evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
      },
      idempotencyKey: 'cli-supervisor-actions:attach',
    })
  })

  test('supports ApplyTransition, Escalate, PauseSupervision, and UnpauseSupervision JSON actions', async () => {
    const bodies: unknown[] = []
    const fetchImpl = async (_input: Request | string | URL, init?: RequestInit) => {
      bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
      return new Response(
        JSON.stringify({
          task: {
            taskId: 'T-01396',
            state: { status: 'active', phase: 'doing' },
            version: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const actions = [
      {
        key: 'apply',
        json: '{"type":"apply_transition","transitionId":"close_success","evidenceRefs":["evd_1"],"expectedTaskVersion":1}',
      },
      {
        key: 'escalate',
        json: '{"type":"escalate","reason":"blocked","severity":"high","audience":"maintainers"}',
      },
      { key: 'pause', json: '{"type":"pause_supervision","reason":"human handoff"}' },
      { key: 'unpause', json: '{"type":"unpause_supervision","reason":"ready"}' },
    ]

    for (const action of actions) {
      await runWorkflowActionCommand(
        [
          '--server',
          'http://acp.test',
          '--actor',
          'rex',
          '--task',
          'T-01396',
          '--supervisor-run',
          'supervisor-run-1',
          '--action',
          action.json,
          '--idempotency-key',
          `cli-supervisor-actions:${action.key}`,
        ],
        { fetchImpl }
      )
    }

    expect(bodies).toEqual([
      expect.objectContaining({
        action: {
          type: 'apply_transition',
          transitionId: 'close_success',
          evidenceRefs: ['evd_1'],
          expectedTaskVersion: 1,
        },
      }),
      expect.objectContaining({
        action: {
          type: 'escalate',
          reason: 'blocked',
          severity: 'high',
          audience: 'maintainers',
        },
      }),
      expect.objectContaining({
        action: { type: 'pause_supervision', reason: 'human handoff' },
      }),
      expect.objectContaining({
        action: { type: 'unpause_supervision', reason: 'ready' },
      }),
    ])
  })
})
