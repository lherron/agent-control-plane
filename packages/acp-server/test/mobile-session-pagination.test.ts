import { describe, expect, test } from 'bun:test'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { SessionFacetsRequest, SessionPageRequest, SessionPageResponse } from 'hrc-sdk'

import type { AcpHrcClient } from '../src/deps.js'
import { withWiredServer } from './fixtures/wired-server.js'

const NOW = '2026-08-11T20:00:00.000Z'
const LOCAL_SESSION: HrcSessionRecord = {
  hostSessionId: 'hsid-local',
  scopeRef: 'agent:cody:project:hrc-ios:task:primary',
  laneRef: 'main',
  generation: 3,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  ancestorScopeRefs: [],
  lastAppliedIntentJson: { execution: { preferredMode: 'interactive' } },
}
const LOCAL_RUNTIME: HrcRuntimeSnapshot = {
  runtimeId: 'runtime-local',
  hostSessionId: LOCAL_SESSION.hostSessionId,
  scopeRef: LOCAL_SESSION.scopeRef,
  laneRef: LOCAL_SESSION.laneRef,
  generation: LOCAL_SESSION.generation,
  transport: 'tmux',
  harness: 'codex',
  provider: 'openai',
  status: 'active',
  supportsInflightInput: true,
  adopted: false,
  createdAt: NOW,
  updatedAt: NOW,
}

function createPaginatedClient(input: {
  pageRequests: SessionPageRequest[]
  facetRequests: SessionFacetsRequest[]
}): AcpHrcClient {
  const page: SessionPageResponse = {
    items: [
      {
        nodeId: 'svc',
        hostSessionId: LOCAL_SESSION.hostSessionId,
        scopeRef: LOCAL_SESSION.scopeRef,
        laneRef: LOCAL_SESSION.laneRef,
        generation: LOCAL_SESSION.generation,
        agentId: 'cody',
        projectId: 'hrc-ios',
        createdAt: NOW,
        effectiveStatus: 'active',
        executionMode: 'interactive',
        lastActivityAt: NOW,
      },
      {
        nodeId: 'max3',
        hostSessionId: LOCAL_SESSION.hostSessionId,
        scopeRef: 'agent:mable:project:hrc-runtime:task:primary',
        laneRef: 'main',
        generation: 1,
        agentId: 'mable',
        projectId: 'hrc-runtime',
        createdAt: '2026-08-11T19:00:00.000Z',
        effectiveStatus: 'detached',
        executionMode: 'headless',
        lastActivityAt: '2026-08-11T19:30:00.000Z',
      },
      {
        // A wrkc/webhook-driven codex worker: HRC reports nonInteractive, the
        // app must bucket it as headless (it is not a session you can type into).
        nodeId: 'max3',
        hostSessionId: 'hsid-worker',
        scopeRef: 'agent:cody:project:agent-control-plane:task:T-07626',
        laneRef: 'main',
        generation: 1,
        agentId: 'cody',
        projectId: 'agent-control-plane',
        createdAt: '2026-08-11T19:00:00.000Z',
        effectiveStatus: 'active',
        executionMode: 'nonInteractive',
        lastActivityAt: '2026-08-11T19:40:00.000Z',
      },
    ],
    nextCursor: 'opaque-next',
    eventHighWater: { svc: 400, max3: 500 },
    complete: false,
    peerStatus: {
      max3: { state: 'unreachable', checkedAt: NOW, detail: 'peer asleep' },
    },
  }
  return {
    listSessionsPage: async (request) => {
      input.pageRequests.push(request)
      return page
    },
    getSessionFacets: async (request) => {
      input.facetRequests.push(request)
      return {
        total: 8174,
        byEffectiveStatus: { active: 153, detached: 14, inactive: 7995, stale: 12 },
        byExecutionMode: { interactive: 7579, headless: 595 },
        byAgentId: { cody: 4100, mable: 4074 },
        byNodeId: { svc: 7579, max3: 595 },
        complete: false,
        peerStatus: page.peerStatus,
      }
    },
    getStatus: async () => ({ node: { nodeId: 'svc' } }) as never,
    getSession: async () => LOCAL_SESSION,
    listRuntimes: async () => [LOCAL_RUNTIME],
  } as unknown as AcpHrcClient
}

describe('GET /v2/mobile/sessions', () => {
  test('forwards one opaque cursor and bounded filters to HRC and preserves authoritative facets', async () => {
    const pageRequests: SessionPageRequest[] = []
    const facetRequests: SessionFacetsRequest[] = []
    const hrcClient = createPaginatedClient({ pageRequests, facetRequests })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'GET',
          path: '/v2/mobile/sessions?limit=50&cursor=opaque-current&q=mable&agentId=mable&nodeId=max3%2Csvc&effectiveStatus=detached',
        })

        expect(response.status).toBe(200)
        const body = await json<{
          sessions: Array<Record<string, unknown>>
          pageInfo: Record<string, unknown>
          facets: Record<string, unknown>
        }>(response)
        expect(pageRequests).toEqual([
          {
            limit: 50,
            cursor: 'opaque-current',
            q: 'mable',
            agentId: 'mable',
            effectiveStatus: 'detached',
            nodes: 'max3,svc',
          },
        ])
        expect(facetRequests).toEqual([
          {
            q: 'mable',
            agentId: 'mable',
            effectiveStatus: 'detached',
            nodes: 'max3,svc',
          },
        ])
        expect(body.sessions).toHaveLength(3)
        expect(body.sessions.map((session) => [session.executionMode, session.mode])).toEqual([
          ['interactive', 'interactive'],
          ['headless', 'headless'],
          ['nonInteractive', 'headless'],
        ])
        expect(body.sessions[0]).toMatchObject({
          nodeId: 'svc',
          hostSessionId: 'hsid-local',
          summaryStatus: 'active',
          executionMode: 'interactive',
          capabilities: { input: true, timeline: true },
        })
        expect(body.sessions[1]).toMatchObject({
          nodeId: 'max3',
          hostSessionId: 'hsid-local',
          summaryStatus: 'detached',
          executionMode: 'headless',
          capabilities: { input: false, timeline: false },
        })
        expect(body.pageInfo).toEqual({
          nextCursor: 'opaque-next',
          localNodeId: 'svc',
          eventHighWater: { svc: 400, max3: 500 },
          complete: false,
          peerStatus: { max3: 'unreachable' },
        })
        expect(body.facets).toMatchObject({
          total: 8174,
          byNodeId: { svc: 7579, max3: 595 },
          complete: false,
          peerStatus: { max3: 'unreachable' },
        })
      },
      { hrcClient }
    )
  })

  test('rejects requests larger than the iOS page contract before calling HRC', async () => {
    const pageRequests: SessionPageRequest[] = []
    const facetRequests: SessionFacetsRequest[] = []
    const hrcClient = createPaginatedClient({ pageRequests, facetRequests })

    await withWiredServer(
      async ({ request }) => {
        const response = await request({ method: 'GET', path: '/v2/mobile/sessions?limit=51' })
        expect(response.status).toBe(400)
        expect(pageRequests).toEqual([])
        expect(facetRequests).toEqual([])
      },
      { hrcClient }
    )
  })
})
