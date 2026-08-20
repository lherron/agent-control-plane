import { parseScopeRef } from 'agent-scope'
import { buildRuntimeBundleRef } from 'spaces-config'

import { json, notFound } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import { parseSessionRefField } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleResolveRuntime: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const parsedScope = parseScopeRef(sessionRef.scopeRef)

  const resolvedPlacement = deps.runtimeResolver
    ? await deps.runtimeResolver(sessionRef)
    : undefined
  const agentRoot =
    resolvedPlacement?.agentRoot ??
    (deps.agentRootResolver
      ? await deps.agentRootResolver({ agentId: parsedScope.agentId, sessionRef })
      : undefined)
  if (agentRoot === undefined) {
    notFound(`runtime placement not found for ${sessionRef.scopeRef}`, {
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
    })
  }

  // Surface persisted placement metadata from admin store when available
  const agent = deps.adminStore.agents.get(parsedScope.agentId)
  const agentHomeDir = agent?.homeDir ?? null

  let projectRootDir: string | null = null
  if (parsedScope.projectId !== undefined) {
    const project = deps.adminStore.projects.get(parsedScope.projectId)
    projectRootDir = project?.homeDir ?? project?.rootDir ?? resolvedPlacement?.projectRoot ?? null
    if (projectRootDir === null) {
      notFound(`project root not found for ${sessionRef.scopeRef}`, {
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        projectId: parsedScope.projectId,
      })
    }
  }

  if (resolvedPlacement !== undefined) {
    return json({
      placement: {
        ...resolvedPlacement,
        agentRoot,
        ...(projectRootDir === null ? {} : { projectRoot: projectRootDir, cwd: projectRootDir }),
      },
    })
  }

  return json({
    placement: {
      agentRoot,
      ...(projectRootDir !== null ? { projectRoot: projectRootDir, cwd: projectRootDir } : {}),
      runMode: 'task',
      bundle: buildRuntimeBundleRef({
        agentName: parsedScope.agentId,
        agentRoot,
        ...(projectRootDir !== null ? { projectRoot: projectRootDir } : {}),
      }),
      correlation: { sessionRef },
      homeDir: agentHomeDir,
      projectRootDir: projectRootDir,
      delegated:
        agentHomeDir === null || (parsedScope.projectId !== undefined && projectRootDir === null),
    },
  })
}
