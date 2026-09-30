import { describe, expect, test } from 'bun:test'

import { isTaskboardTaskId, taskboardTaskUrl } from '../taskboard-links.js'

describe('taskboard task links (T-09895)', () => {
  test('recognizes ordinary and named subtask ids', () => {
    expect(isTaskboardTaskId('T-12345')).toBe(true)
    expect(isTaskboardTaskId('T-12345.render-preview')).toBe(true)
  })

  test('refuses room keys and ids outside the task-id grammar', () => {
    for (const value of ['T-12345.2', 'T-12345/reviewer', 'T-12345.Slug', 'primary', '']) {
      expect(isTaskboardTaskId(value)).toBe(false)
    }
  })

  test('links the full subtask id, not its owner', () => {
    expect(taskboardTaskUrl('agent-control-plane', 'T-12345.render-preview')).toEndWith(
      '/inbox-hub/agent-control-plane/T-12345.render-preview'
    )
  })
})
