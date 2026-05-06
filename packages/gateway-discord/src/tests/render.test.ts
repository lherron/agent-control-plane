import { describe, expect, test } from 'bun:test'

import {
  buildProgressBubble,
  extractToolPreview,
  formatNoticeLine,
  formatToolLine,
  getToolEmoji,
  renderActionsToCustomIds,
  renderFrameToDiscordContent,
  splitIntoChunks,
} from '../render.js'
import type { RenderFrame } from '../types.js'

// ---------------------------------------------------------------------------
// Existing tests (unchanged)
// ---------------------------------------------------------------------------

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

test('splitIntoChunks emits prose as raw markdown by default', () => {
  const chunks = splitIntoChunks('Hello world\nThis is some text', 2000)

  expect(chunks).toHaveLength(1)
  expect(chunks[0]).toBe('Hello world\nThis is some text')
})

test('splitIntoChunks preserves agent-emitted code fences with default prose mode', () => {
  const chunks = splitIntoChunks(
    'Some prose\n\n```javascript\nconst x = 1;\n```\n\nMore prose',
    2000
  )

  const joined = chunks.join('\n')
  expect(joined).toContain('Some prose')
  expect(joined).toContain('```javascript')
  expect(joined).toContain('const x = 1')
  expect(joined).toContain('More prose')
  // Prose segments should not be wrapped in their own code fences
  expect(joined).not.toContain('```\nSome prose')
  expect(joined).not.toContain('More prose\n```')
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

// ---------------------------------------------------------------------------
// Per-tool emoji map
// ---------------------------------------------------------------------------

describe('getToolEmoji', () => {
  test('returns correct emoji for each known tool', () => {
    expect(getToolEmoji('Bash')).toBe('💻')
    expect(getToolEmoji('Read')).toBe('📖')
    expect(getToolEmoji('Write')).toBe('✍️')
    expect(getToolEmoji('Edit')).toBe('🔧')
    expect(getToolEmoji('Grep')).toBe('🔎')
    expect(getToolEmoji('Glob')).toBe('📁')
    expect(getToolEmoji('Task')).toBe('🤖')
    expect(getToolEmoji('WebFetch')).toBe('📄')
    expect(getToolEmoji('WebSearch')).toBe('🔍')
    expect(getToolEmoji('TodoWrite')).toBe('📋')
    expect(getToolEmoji('NotebookEdit')).toBe('📓')
  })

  test('returns default gear emoji for unknown tools', () => {
    expect(getToolEmoji('UnknownTool')).toBe('⚙️')
    expect(getToolEmoji('CustomPlugin')).toBe('⚙️')
  })
})

// ---------------------------------------------------------------------------
// Primary-arg preview extraction
// ---------------------------------------------------------------------------

describe('extractToolPreview', () => {
  test('extracts file_path for Read', () => {
    expect(extractToolPreview('Read', { file_path: '/src/index.ts' }, '')).toBe('/src/index.ts')
  })

  test('extracts command for Bash', () => {
    expect(extractToolPreview('Bash', { command: 'ls -la', description: 'list files' }, '')).toBe(
      'ls -la'
    )
  })

  test('extracts pattern for Grep', () => {
    expect(extractToolPreview('Grep', { pattern: 'TODO', path: '/src' }, '')).toBe('TODO')
  })

  test('extracts pattern for Glob', () => {
    expect(extractToolPreview('Glob', { pattern: '**/*.ts' }, '')).toBe('**/*.ts')
  })

  test('extracts description for Task', () => {
    expect(extractToolPreview('Task', { description: 'Run tests' }, '')).toBe('Run tests')
  })

  test('extracts url for WebFetch', () => {
    expect(extractToolPreview('WebFetch', { url: 'https://example.com' }, '')).toBe(
      'https://example.com'
    )
  })

  test('extracts query for WebSearch', () => {
    expect(extractToolPreview('WebSearch', { query: 'bun test runner' }, '')).toBe(
      'bun test runner'
    )
  })

  test('extracts notebook_path for NotebookEdit', () => {
    expect(extractToolPreview('NotebookEdit', { notebook_path: '/nb.ipynb' }, '')).toBe('/nb.ipynb')
  })

  test('shows todo count for TodoWrite', () => {
    expect(extractToolPreview('TodoWrite', { todos: [{ text: 'a' }, { text: 'b' }] }, '')).toBe(
      '2 todos'
    )
  })

  test('shows singular todo for TodoWrite with one item', () => {
    expect(extractToolPreview('TodoWrite', { todos: [{ text: 'a' }] }, '')).toBe('1 todo')
  })

  test('falls back to first string arg for unknown tool', () => {
    expect(extractToolPreview('CustomTool', { count: 42, path: '/foo' }, '')).toBe('/foo')
  })

  test('falls back to summary when no input provided', () => {
    expect(extractToolPreview('Read', undefined, '`/src/index.ts`')).toBe('/src/index.ts')
  })

  test('strips backtick wrapping from legacy summary', () => {
    expect(extractToolPreview('Bash', undefined, '`echo hello`')).toBe('echo hello')
  })
})

// ---------------------------------------------------------------------------
// formatToolLine
// ---------------------------------------------------------------------------

describe('formatToolLine', () => {
  test('formats running tool with correct emoji and quoted preview', () => {
    const line = formatToolLine('Read', { file_path: '/src/index.ts' }, '', false)
    expect(line).toBe('📖 Read: "/src/index.ts"')
  })

  test('formats failed tool with ❌ emoji', () => {
    const line = formatToolLine('Read', { file_path: '/src/index.ts' }, '', true)
    expect(line).toBe('❌ Read: "/src/index.ts"')
  })

  test('truncates preview to fit 80-char line cap', () => {
    const longPath = `/very/long/path/${'a'.repeat(100)}.ts`
    const line = formatToolLine('Read', { file_path: longPath }, '', false)
    expect(line.length).toBeLessThanOrEqual(80)
    expect(line).toContain('...')
  })

  test('uses legacy summary when input is absent', () => {
    const line = formatToolLine('Bash', undefined, '`echo hello`', false)
    expect(line).toContain('echo hello')
    expect(line).toContain('💻')
  })

  test('uses default emoji for unknown tool', () => {
    const line = formatToolLine('UnknownTool', { arg: 'value' }, '', false)
    expect(line).toContain('⚙️')
    expect(line).toContain('UnknownTool')
  })

  test('never exceeds 80 chars', () => {
    const line = formatToolLine('Bash', { command: 'x'.repeat(200) }, '', false)
    expect(line.length).toBeLessThanOrEqual(80)
  })
})

// ---------------------------------------------------------------------------
// formatNoticeLine
// ---------------------------------------------------------------------------

describe('formatNoticeLine', () => {
  test('formats info notice with ℹ️', () => {
    expect(formatNoticeLine('info', 'connected')).toBe('ℹ️ connected')
  })

  test('formats warn notice with ⚠️', () => {
    expect(formatNoticeLine('warn', 'slow query')).toBe('⚠️ slow query')
  })

  test('formats error notice with ❌', () => {
    expect(formatNoticeLine('error', 'crash')).toBe('❌ crash')
  })

  test('truncates long messages to 80 chars', () => {
    const line = formatNoticeLine('info', 'x'.repeat(200))
    expect(line.length).toBeLessThanOrEqual(80)
    expect(line).toContain('...')
  })
})

// ---------------------------------------------------------------------------
// renderBlock — tool block rendering
// ---------------------------------------------------------------------------

describe('renderBlock tool rendering', () => {
  test('renders tool block with per-tool emoji and input-based preview', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: [
        {
          t: 'tool',
          toolName: 'Read',
          summary: '`/src/index.ts`',
          input: { file_path: '/src/index.ts' },
        } as never,
      ],
      updatedAt: Date.now(),
    }
    const content = renderFrameToDiscordContent(frame, 2000)
    expect(content).toContain('📖 Read: "/src/index.ts"')
  })

  test('renders failed tool with ❌ replacing tool emoji', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: [
        {
          t: 'tool',
          toolName: 'Bash',
          summary: '`ls`',
          approved: false,
          input: { command: 'ls' },
        } as never,
      ],
      updatedAt: Date.now(),
    }
    const content = renderFrameToDiscordContent(frame, 2000)
    expect(content).toContain('❌ Bash: "ls"')
    expect(content).not.toContain('💻')
  })

  test('compact mode suppresses output and images', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: [
        {
          t: 'tool',
          toolName: 'Bash',
          summary: '`echo hi`',
          output: 'hi\nsome output\nmore lines\nextra line',
          images: [{ data: 'base64data', mimeType: 'image/png' }],
          approved: true,
          input: { command: 'echo hi' },
        } as never,
      ],
      updatedAt: Date.now(),
    }

    const fullContent = renderFrameToDiscordContent(frame, 2000)
    expect(fullContent).toContain('```')
    expect(fullContent).toContain('image')

    const compactContent = renderFrameToDiscordContent(frame, 2000, { compact: true })
    expect(compactContent).not.toContain('```')
    expect(compactContent).not.toContain('image')
    expect(compactContent).toContain('💻 Bash: "echo hi"')
  })
})

// ---------------------------------------------------------------------------
// renderBlock — notice block rendering
// ---------------------------------------------------------------------------

describe('renderBlock notice rendering', () => {
  test('renders notice blocks with correct icons', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: [
        { t: 'notice', level: 'info', message: 'connected to live session stream' },
        { t: 'notice', level: 'warn', message: 'tool output was compacted' },
        { t: 'notice', level: 'error', message: 'tool progress edit failed' },
      ] as never,
      updatedAt: Date.now(),
    }
    const content = renderFrameToDiscordContent(frame, 2000)
    expect(content).toContain('ℹ️ connected to live session stream')
    expect(content).toContain('⚠️ tool output was compacted')
    expect(content).toContain('❌ tool progress edit failed')
  })
})

// ---------------------------------------------------------------------------
// buildProgressBubble
// ---------------------------------------------------------------------------

describe('buildProgressBubble', () => {
  function makeToolBlock(index: number, toolName = 'Read') {
    return {
      t: 'tool' as const,
      toolName,
      summary: '',
      approved: true,
      input: {
        file_path: `packages/gateway-discord/src/fixture-${String(index).padStart(2, '0')}.ts`,
      },
    }
  }

  test('renders up to 12 tool lines without collapse', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: Array.from({ length: 12 }, (_, i) => makeToolBlock(i)) as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    const lines = bubble.split('\n')
    const toolLines = lines.filter((l) => l.includes('📖 Read:'))
    expect(toolLines).toHaveLength(12)
    expect(bubble).not.toContain('earlier tools')
  })

  test('collapses oldest when exceeding 12 lines', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: Array.from({ length: 15 }, (_, i) => makeToolBlock(i)) as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    expect(bubble).toContain('_... +3 earlier tools_')
    const toolLines = bubble.split('\n').filter((l) => l.includes('📖 Read:'))
    expect(toolLines).toHaveLength(12)
    // Should contain the last tool (index 14), not the first (index 0)
    expect(bubble).toContain('fixture-14.ts')
    expect(bubble).not.toContain('fixture-00.ts')
  })

  test('20 tools with 12-line cap shows +8 collapsed', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: Array.from({ length: 20 }, (_, i) => makeToolBlock(i)) as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    expect(bubble).toContain('_... +8 earlier tools_')
    const toolLines = bubble.split('\n').filter((l) => l.includes('📖 Read:'))
    expect(toolLines).toHaveLength(12)
    expect(bubble).toContain('fixture-19.ts')
  })

  test('keeps assistant text intact and drops tool lines to fit budget', () => {
    const longAnswer = `Final answer begins. ${'This answer must remain intact after compacting the tool history. '.repeat(18)}Final answer ends.`

    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: [
        ...Array.from({ length: 20 }, (_, i) => makeToolBlock(i)),
        { t: 'markdown', md: longAnswer },
      ] as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    expect(bubble.length).toBeLessThanOrEqual(1900)
    expect(bubble).toContain(longAnswer)
    expect(bubble).toContain('Final answer ends.')
    expect(bubble).toContain('earlier tools')
  })

  test('stays within 1900 char budget', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: Array.from({ length: 50 }, (_, i) => makeToolBlock(i)) as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    expect(bubble.length).toBeLessThanOrEqual(1900)
  })

  test('notice blocks count toward line cap', () => {
    const blocks = [
      ...Array.from({ length: 10 }, (_, i) => makeToolBlock(i)),
      { t: 'notice' as const, level: 'info' as const, message: 'notice A' },
      { t: 'notice' as const, level: 'warn' as const, message: 'notice B' },
      { t: 'notice' as const, level: 'error' as const, message: 'notice C' },
    ]

    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: blocks as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    // 13 total tool/notice lines > 12 cap → should collapse 1
    expect(bubble).toContain('_... +1 earlier tools_')
    // All 3 notices should still be visible (they're at the end, oldest collapsed first)
    expect(bubble).toContain('ℹ️ notice A')
    expect(bubble).toContain('⚠️ notice B')
    expect(bubble).toContain('❌ notice C')
  })

  test('custom maxLines and maxChars options are respected', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: Array.from({ length: 8 }, (_, i) => makeToolBlock(i)) as never,
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame, { maxLines: 5 })
    const toolLines = bubble.split('\n').filter((l) => l.includes('📖 Read:'))
    expect(toolLines).toHaveLength(5)
    expect(bubble).toContain('_... +3 earlier tools_')
  })

  test('empty frame produces empty string', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'p1',
      phase: 'progress',
      blocks: [],
      updatedAt: Date.now(),
    }

    const bubble = buildProgressBubble(frame)
    expect(bubble).toBe('')
  })
})
