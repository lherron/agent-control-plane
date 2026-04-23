/**
 * Shared helpers for streaming NDJSON event replay from /sessions/{id}/events.
 *
 * Used by `acp tail` (incremental live print) and `acp render` (replay-backed
 * state fold).  This module is acp-cli-internal — do NOT re-export from
 * packages consumed by other packages.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TailEvent = Record<string, unknown>

/**
 * The reduced "rendered view" produced by folding a stream of session events.
 * Currently the render is a text frame built by concatenating content from
 * content-bearing events.  Extend the fold as the event schema evolves.
 */
export type RenderedView = {
  /** Concatenated text content from content-bearing events. */
  text: string
  /** Total number of events consumed during the fold. */
  eventCount: number
  /** Last hrcSeq seen, if any. */
  lastSeq: number | undefined
}

// ---------------------------------------------------------------------------
// NDJSON parsing helpers
// ---------------------------------------------------------------------------

/** Parse a single non-empty NDJSON line into a TailEvent. */
export function parseNdjsonLine(line: string): TailEvent {
  return JSON.parse(line) as TailEvent
}

/** Parse a complete NDJSON text blob into an array of TailEvent. */
export function parseNdjsonText(text: string): TailEvent[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseNdjsonLine)
}

// ---------------------------------------------------------------------------
// Async streaming — yields TailEvent records as they arrive from a
// ReadableStream<Uint8Array> (i.e. `response.body`).
// ---------------------------------------------------------------------------

/**
 * Async generator that reads a ReadableStream of bytes and yields one
 * `TailEvent` per NDJSON line *as it arrives*.  The caller can print /
 * process each event without waiting for the stream to close.
 */
export async function* streamNdjsonEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<TailEvent, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: true })
      }

      // Yield every complete line currently in the buffer.
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line.length > 0) {
          yield parseNdjsonLine(line)
        }
        newlineIdx = buffer.indexOf('\n')
      }

      if (done) {
        // Flush any trailing partial line.
        const trailing = buffer.trim()
        if (trailing.length > 0) {
          yield parseNdjsonLine(trailing)
        }
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Replay reducer — folds an event stream into a RenderedView.
// ---------------------------------------------------------------------------

function extractText(event: TailEvent): string | undefined {
  // Events may carry content in several shapes; prefer `content.text`, then
  // `text`, then fall back to undefined.
  const content = event['content']
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const t = (content as { text: unknown }).text
    if (typeof t === 'string') return t
  }
  if (typeof event['text'] === 'string') return event['text'] as string
  return undefined
}

/** Fold a single event into an accumulating RenderedView (pure). */
export function foldEvent(view: RenderedView, event: TailEvent): RenderedView {
  const text = extractText(event)
  const seq = typeof event['hrcSeq'] === 'number' ? (event['hrcSeq'] as number) : view.lastSeq

  return {
    text: text !== undefined ? view.text + text : view.text,
    eventCount: view.eventCount + 1,
    lastSeq: seq,
  }
}

/** Create a fresh empty RenderedView. */
export function emptyView(): RenderedView {
  return { text: '', eventCount: 0, lastSeq: undefined }
}

/** Reduce a complete array of events to a RenderedView. */
export function reduceEvents(events: TailEvent[]): RenderedView {
  return events.reduce(foldEvent, emptyView())
}

/**
 * Reduce events arriving from an async iterable (e.g. the streaming
 * generator) into a single RenderedView.
 */
export async function reduceEventStream(stream: AsyncIterable<TailEvent>): Promise<RenderedView> {
  let view = emptyView()
  for await (const event of stream) {
    view = foldEvent(view, event)
  }
  return view
}
