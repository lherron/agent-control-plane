import { dirname } from 'node:path'

import type { DeclarationRunMode } from 'hrc-core'

import { badRequest, json, notFound } from '../http.js'
import {
  type FetchPlacementResolution,
  type FetchRunPreview,
  daemonHarnessToHrcHarness,
  fetchPlacementResolution,
  fetchRunPreview,
} from '../placement-resolution.js'
import type { RouteHandler } from '../routing/route-context.js'
import { provenance } from './admin-detail-shared.js'

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }

  return agentId
}

function parseRunMode(value: string | null): DeclarationRunMode {
  if (value === null || value.length === 0) {
    return 'query'
  }

  if (value === 'query' || value === 'heartbeat' || value === 'task' || value === 'maintenance') {
    return value
  }

  badRequest('runMode must be one of: query, heartbeat, task, maintenance', {
    field: 'runMode',
  })
}

export const handleGetAdminAgentSystemPrompt: RouteHandler = async ({ params, url, deps }) => {
  const agentId = requireAgentId(params)
  const agent = deps.adminStore.agents.get(agentId)
  if (agent === undefined) {
    notFound('agent not found', { agentId })
  }

  const projectId = url.searchParams.get('projectId')
  const runMode = parseRunMode(url.searchParams.get('runMode'))
  const project = projectId === null ? undefined : deps.adminStore.projects.get(projectId)
  if (projectId !== null && project === undefined) {
    notFound('project not found', { projectId })
  }

  // T-08598: the compiled prompt comes from the HRC daemon (`POST
  // /v1/previews/run`), which reads declarations through aspd. ACP keeps no
  // local profile/template interpretation.
  const fetchPlacement: FetchPlacementResolution = deps.placementFetch ?? fetchPlacementResolution
  const placement = await fetchPlacement({
    agentId,
    ...(projectId !== null ? { projectId } : {}),
    runMode,
  })
  const agentRoot = agent.homeDir ?? placement.agentRoot
  const projectRoot = project?.homeDir ?? project?.rootDir ?? placement.projectRoot
  const fetchPreview: FetchRunPreview = deps.runPreviewFetch ?? fetchRunPreview
  const preview = await fetchPreview({
    intent: {
      placement: {
        agentRoot,
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        cwd: projectRoot ?? placement.cwd ?? agentRoot,
        runMode,
        bundle: placement.bundle,
        dryRun: false,
      },
      harness: daemonHarnessToHrcHarness(placement.harness),
    },
    sessionRef: `agent:${agentId}${projectId !== null ? `:project:${projectId}` : ''}/lane:main`,
  })

  if (preview.systemPrompt === null) {
    return json({
      systemPrompt: null,
      provenance: [
        provenance('admin_store.agents', true),
        provenance('admin_store.projects', projectId === null || project !== undefined),
        provenance('hrc.previews.run', false),
      ],
    })
  }

  const promptChars = preview.systemPrompt.length
  const reminderChars = preview.reminderContent?.length ?? 0
  return json({
    systemPrompt: {
      agentRoot,
      agentsRoot: placement.agentSources?.agentsRoot ?? dirname(agentRoot),
      agentName: agentId,
      runMode,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(projectId !== null ? { projectId } : {}),
      template: { kind: 'daemon', mode: preview.systemPromptMode },
      prompt: {
        content: preview.systemPrompt,
        mode: preview.systemPromptMode,
        totalChars: promptChars,
        sections: [],
      },
      reminder: {
        ...(preview.reminderContent !== undefined ? { content: preview.reminderContent } : {}),
        totalChars: reminderChars,
        sections: [],
      },
      diagnostics: {
        prompt: { sectionSizes: preview.promptSectionSizes, totalChars: promptChars },
        reminder: { sectionSizes: preview.reminderSectionSizes, totalChars: reminderChars },
        totalChars: preview.totalContextChars,
        nearMaxChars: preview.nearMaxChars,
      },
    },
    provenance: [
      provenance('admin_store.agents', true),
      provenance('admin_store.projects', projectId === null || project !== undefined),
      provenance('hrc.previews.run', true),
    ],
  })
}
