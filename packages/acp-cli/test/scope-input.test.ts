import { describe, expect, test } from 'bun:test'

import { normalizeScopeInput } from '../src/scope-input.js'

describe('normalizeScopeInput', () => {
  test('normalizes a scope handle with project and task', () => {
    expect(normalizeScopeInput('cody@agent-spaces:T-01140')).toEqual({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01140',
      laneRef: undefined,
    })
  })

  test('normalizes a role-scoped handle', () => {
    expect(normalizeScopeInput('cody@agent-spaces:T-01140/tester')).toEqual({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01140:role:tester',
      laneRef: undefined,
    })
  })

  test('accepts canonical scope refs unchanged', () => {
    expect(normalizeScopeInput('agent:cody:project:agent-spaces:task:T-01140:role:tester')).toEqual(
      {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01140:role:tester',
        laneRef: undefined,
      }
    )
  })

  test('normalizes session handles with lane suffixes', () => {
    expect(normalizeScopeInput('cody@agent-spaces:T-01140/tester~repair')).toEqual({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01140:role:tester',
      laneRef: 'lane:repair',
    })
  })

  test('throws on conflicting lane inputs', () => {
    expect(() => normalizeScopeInput('cody@agent-spaces:T-01140~repair', 'main')).toThrow(
      'Conflicting lane inputs'
    )
  })

  test('rejects invalid role characters', () => {
    expect(() => normalizeScopeInput('cody@agent-spaces:T-01140/tester!')).toThrow(
      'roleName contains invalid characters'
    )
  })
})
