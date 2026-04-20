import { handleGetRun } from '../handlers/runs-get.js'
import { handleAttachTaskEvidence } from '../handlers/tasks-evidence.js'
import { handleGetTask } from '../handlers/tasks-get.js'
import { handlePromoteTask } from '../handlers/tasks-promote.js'
import { handleApplyTaskTransition } from '../handlers/tasks-transition.js'
import { handleListTaskTransitions } from '../handlers/tasks-transitions.js'

import type { RouteHandler, RouteParams } from './route-context.js'

export type ParamRoute = {
  method: string
  pattern: RegExp
  extract(pathname: string): RouteParams | undefined
  handler: RouteHandler
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createParamRoute(
  method: string,
  template: string,
  handler: RouteHandler
): ParamRoute {
  const segments = template.split('/').filter((segment) => segment.length > 0)
  const paramNames: string[] = []
  const pattern = new RegExp(
    `^/${segments
      .map((segment) => {
        if (!segment.startsWith(':')) {
          return escapeRegExp(segment)
        }

        paramNames.push(segment.slice(1))
        return '([^/]+)'
      })
      .join('/')}$`
  )

  return {
    method,
    pattern,
    handler,
    extract(pathname: string): RouteParams | undefined {
      const match = pathname.match(pattern)
      if (match === null) {
        return undefined
      }

      return paramNames.reduce<RouteParams>((params, name, index) => {
        params[name] = decodeURIComponent(match[index + 1] as string)
        return params
      }, {})
    },
  }
}

export function buildParamRoutes(): ParamRoute[] {
  return [
    createParamRoute('GET', '/v1/tasks/:taskId', handleGetTask),
    createParamRoute('POST', '/v1/tasks/:taskId/evidence', handleAttachTaskEvidence),
    createParamRoute('POST', '/v1/tasks/:taskId/promote', handlePromoteTask),
    createParamRoute('POST', '/v1/tasks/:taskId/transitions', handleApplyTaskTransition),
    createParamRoute('GET', '/v1/tasks/:taskId/transitions', handleListTaskTransitions),
    createParamRoute('GET', '/v1/runs/:runId', handleGetRun),
  ]
}

export function matchParamRoute(
  routes: readonly ParamRoute[],
  method: string,
  pathname: string
): { handler: RouteHandler; params: RouteParams } | undefined {
  for (const route of routes) {
    if (route.method !== method) {
      continue
    }

    const params = route.extract(pathname)
    if (params !== undefined) {
      return {
        handler: route.handler,
        params,
      }
    }
  }

  return undefined
}
