const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/
const TOKEN_MIN_LENGTH = 1
const TOKEN_MAX_LENGTH = 64
const SCOPE_REF_PATTERN =
  /^agent:([^:]+)(?::project:([^:]+)(?::(?:role:([^:]+)|task:([^:]+)(?::role:([^:]+))?))?)?$/

function validateToken(value: string, label: string): void {
  if (value.length < TOKEN_MIN_LENGTH || value.length > TOKEN_MAX_LENGTH) {
    throw new Error(
      `${label} must be ${TOKEN_MIN_LENGTH}..${TOKEN_MAX_LENGTH} characters, got ${value.length}`
    )
  }
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters: must match [A-Za-z0-9._-]+`)
  }
}

function normalizeLaneRef(laneRef?: string): string | undefined {
  if (laneRef === undefined || laneRef === '') return undefined
  if (laneRef === 'main') return 'main'

  const normalized = laneRef.startsWith('lane:') ? laneRef : `lane:${laneRef}`
  const laneId = normalized.slice(5)
  validateToken(laneId, 'laneId')
  return normalized
}

function parseScopeHandle(handle: string): string {
  const atIdx = handle.indexOf('@')
  let main = handle
  let roleName: string | undefined

  if (atIdx !== -1) {
    const afterAt = handle.slice(atIdx + 1)
    const slashIdx = afterAt.indexOf('/')
    if (slashIdx !== -1) {
      roleName = afterAt.slice(slashIdx + 1)
      main = handle.slice(0, atIdx + 1 + slashIdx)
    }
  }

  let agentId: string
  let projectId: string | undefined
  let taskId: string | undefined

  if (atIdx === -1) {
    agentId = main
  } else {
    agentId = main.slice(0, atIdx)
    const projectPart = main.slice(atIdx + 1)
    const colonIdx = projectPart.indexOf(':')
    if (colonIdx === -1) {
      projectId = projectPart
    } else {
      projectId = projectPart.slice(0, colonIdx)
      taskId = projectPart.slice(colonIdx + 1)
    }
  }

  validateToken(agentId, 'agentId')
  if (projectId !== undefined) validateToken(projectId, 'projectId')
  if (taskId !== undefined) validateToken(taskId, 'taskId')
  if (roleName !== undefined) validateToken(roleName, 'roleName')

  let scopeRef = `agent:${agentId}`
  if (projectId !== undefined) scopeRef += `:project:${projectId}`
  if (taskId !== undefined) scopeRef += `:task:${taskId}`
  if (roleName !== undefined) scopeRef += `:role:${roleName}`
  return scopeRef
}

function parseSessionHandle(handle: string): { scopeRef: string; laneRef: string } {
  const tildeIdx = handle.indexOf('~')
  const scopePart = tildeIdx === -1 ? handle : handle.slice(0, tildeIdx)
  const laneId = tildeIdx === -1 ? undefined : handle.slice(tildeIdx + 1)
  const normalizedLaneRef =
    laneId === undefined || laneId === 'main' ? 'main' : normalizeLaneRef(laneId)
  if (normalizedLaneRef === undefined) {
    throw new Error(`Invalid LaneRef: ${handle}`)
  }

  return {
    scopeRef: parseScopeHandle(scopePart),
    laneRef: normalizedLaneRef,
  }
}

function normalizeScopeRef(scopeInput: string): string {
  const match = SCOPE_REF_PATTERN.exec(scopeInput)
  if (match) {
    const agentId = match[1]
    const projectId = match[2]
    const roleAtProject = match[3]
    const taskId = match[4]
    const roleAtTask = match[5]
    if (agentId === undefined) {
      throw new Error(`Invalid ScopeRef: ${scopeInput}`)
    }
    validateToken(agentId, 'agentId')
    if (projectId) validateToken(projectId, 'projectId')
    if (taskId) validateToken(taskId, 'taskId')
    const roleName = roleAtProject ?? roleAtTask
    if (roleName) validateToken(roleName, 'roleName')

    let normalized = `agent:${agentId}`
    if (projectId) {
      normalized += `:project:${projectId}`
      if (taskId) {
        normalized += `:task:${taskId}`
        if (roleAtTask) normalized += `:role:${roleAtTask}`
      } else if (roleAtProject) {
        normalized += `:role:${roleAtProject}`
      }
    }
    return normalized
  }

  return parseScopeHandle(scopeInput)
}

export function normalizeScopeInput(
  scopeInput: string,
  laneRef?: string
): { scopeRef: string; laneRef?: string } {
  if (scopeInput.includes('~')) {
    const session = parseSessionHandle(scopeInput)
    const explicitLaneRef = normalizeLaneRef(laneRef)
    if (explicitLaneRef && explicitLaneRef !== session.laneRef) {
      throw new Error(
        `Conflicting lane inputs: session handle lane "${session.laneRef}" does not match --lane-ref "${explicitLaneRef}"`
      )
    }
    return {
      scopeRef: normalizeScopeRef(session.scopeRef),
      ...((explicitLaneRef ?? session.laneRef) !== undefined
        ? { laneRef: explicitLaneRef ?? session.laneRef }
        : {}),
    }
  }

  const normalizedLaneRef = normalizeLaneRef(laneRef)
  return {
    scopeRef: normalizeScopeRef(scopeInput),
    ...(normalizedLaneRef !== undefined ? { laneRef: normalizedLaneRef } : {}),
  }
}
