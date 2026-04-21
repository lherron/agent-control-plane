import { expect, test } from 'bun:test'

import {
  renderActionsToCustomIds,
  renderFrameToDiscordContent,
  splitIntoChunks,
} from '../render.js'

test('gateway-discord renderer maps RenderFrame to message content', () => {
  const content = renderFrameToDiscordContent(
    {
      runId: 'run1',
      projectId: 'proj1',
      phase: 'permission',
      title: 'Permission required',
      statusLine: 'awaiting approval',
      blocks: [
        { t: 'markdown', md: 'Hello' },
        { t: 'code', lang: 'txt', code: 'world' },
        { t: 'kv', items: [{ k: 'tool', v: 'Bash' }] },
      ],
      actions: [{ id: 'a1', kind: 'approve', label: 'Approve', style: 'primary' }],
      updatedAt: Date.now(),
    },
    2000
  )

  expect(content).toContain('Permission required')
  expect(content).toContain('awaiting approval')
  expect(content).toContain('Hello')
  expect(content).toContain('```txt')
  expect(content).toContain('**tool:** Bash')
})

test('gateway-discord renderer maps actions to stable customIds', () => {
  const actions = renderActionsToCustomIds('proj1', 'run1', [
    { id: 'perm:req:allow', kind: 'approve', label: 'Approve', style: 'primary' },
  ])

  expect(actions).toHaveLength(1)
  expect(actions[0]?.customId).toBe('run:proj1:run1:perm:req:allow')
})

test('splitIntoChunks wraps prose in code blocks by default', () => {
  const chunks = splitIntoChunks('Hello world\nThis is some text', 2000)

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.startsWith('```\n')).toBe(true)
  expect(chunks[0]?.endsWith('\n```')).toBe(true)
  expect(chunks[0]).toContain('Hello world')
})

test('splitIntoChunks wraps prose in block quotes when enabled', () => {
  const chunks = splitIntoChunks('Hello world\nThis is some text', 2000, {
    useBlockQuotes: true,
  })

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.startsWith('> ')).toBe(true)
  expect(chunks[0]).toContain('> Hello world')
  expect(chunks[0]).toContain('> This is some text')
  expect(chunks[0]).not.toContain('```')
})

test('splitIntoChunks preserves real code blocks with block quotes enabled', () => {
  const chunks = splitIntoChunks(
    'Some prose\n\n```javascript\nconst x = 1;\n```\n\nMore prose',
    2000,
    { useBlockQuotes: true }
  )

  const joined = chunks.join('\n')
  expect(joined).toContain('> Some prose')
  expect(joined).toContain('```javascript')
  expect(joined).toContain('const x = 1')
  expect(joined).toContain('> More prose')
})
