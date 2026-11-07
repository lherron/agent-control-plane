import { isTaskId } from 'acp-core'
import { normalizeLaneRef } from 'agent-scope'
import type { ViewerIdentity } from './headless-viewer-status.js'

import { shortenProjectId } from './project-prefix.js'

const HEADLESS_SESSIONS_WINDOW_TITLE = 'Headless Sessions'

/**
 * Implicit window key for every pane placed without a `viewerWindow` hint
 * (T-07118). Metadata written before this change carries NO `hrc_window_key`,
 * so an ABSENT key must read as this value — that is what makes today's live
 * topology match without a restamp, and what makes an absent hint a byte-for-
 * byte no-op.
 */
export const DEFAULT_HEADLESS_WINDOW_KEY = 'default'

/** Dedicated keyed window for the hcs context-switcher manager (T-07781). */
export const CHIEF_WINDOW_KEY = 'chief'

/**
 * Window key for the operator's INTERACTIVE window (T-07603) — the one that is
 * not the headless pile. Resolved by adoption (`adoptInteractiveWindow`), never
 * by an operator metadata stamp: the T-07118 stamp lived in Ghostty's in-memory
 * window metadata, so it was wiped on every Ghostty restart and in practice was
 * never reapplied, which is what left HRC minting a second empty window.
 */
export const INTERACTIVE_WINDOW_KEY = 'console'

/** Keep a caller-supplied window key inside the safe metadata-key alphabet. */
export function normalizeWindowKey(windowKey: string | undefined): string {
  const trimmed = (windowKey ?? '').trim()
  if (trimmed.length === 0) return DEFAULT_HEADLESS_WINDOW_KEY
  return sanitizeKeyFragment(trimmed)
}

/** Presentation-only window title derived from the key. */
export function headlessWindowTitle(windowKey: string): string {
  if (windowKey === CHIEF_WINDOW_KEY) return 'Chief Contexts'
  return windowKey === DEFAULT_HEADLESS_WINDOW_KEY
    ? HEADLESS_SESSIONS_WINDOW_TITLE
    : `${HEADLESS_SESSIONS_WINDOW_TITLE} · ${windowKey}`
}

/** Decomposition of a scope ref into the canonical headless tab grouping (T-05237). */
export type HeadlessTabIdentity = {
  /** Canonical grouping key — the ONLY value the TAB grouping may key on. */
  tabKey: string
  agentId: string
  taskId?: string | undefined
  projectId?: string | undefined
  /** Human display label for the tab/pane title (presentation only). */
  label: string
}

/**
 * Full HRC-session identity for a headless viewer PANE (T-06321). A task still
 * owns one tab (`tab.tabKey`), but distinct role-qualified scopes or distinct
 * lanes under that task get distinct panes keyed by `paneKey`, derived from the
 * normalized `(scopeRef, laneRef)` pair. `agentId` is presentation metadata, not
 * uniqueness authority.
 */
export type HeadlessSessionIdentity = {
  /** Tab grouping — one tab per canonical task/project key (unchanged). */
  tab: HeadlessTabIdentity
  /** Canonical pane uniqueness key from normalized `(scopeRef, laneRef)`. */
  paneKey: string
  /** Normalized lane ref (`main` or `lane:<id>`). */
  laneRef: string
  /** Role name when the scope is role-qualified (title + operator diagnosis). */
  roleName?: string | undefined
}

/** A real wrkq task scope is a task or subtask id (`T-05237`, `T-05237.render-preview`). */
function isRealTaskId(taskId: string | undefined): taskId is string {
  return typeof taskId === 'string' && isTaskId(taskId)
}

/** Keep a scope fragment safe inside a `:`-delimited metadata key. */
function sanitizeKeyFragment(value: string): string {
  return value.replace(/[\s:|]+/g, '-').trim() || 'unknown'
}

/**
 * Canonical tab grouping for a headless viewer pane (T-05237, daedalus C1).
 *
 * - Real task scope (`T-XXXXX`):  `task:<T-XXXXX>`        label `<T-XXXXX>`
 * - Non-task scope with a named token (e.g. a T-07118 roster slot such as
 *   `primary-nova`): `project:<proj>:<token>` label `<proj> · <token>` — each
 *   named scope owns its OWN tab (T-07142), so a new widget session opens a
 *   new tab instead of splitting a pane into the shared primary tab.
 * - Bare `primary` / taskless scope: `project:<proj>:primary` label
 *   `<proj> · primary`, where `<proj>` is the projectId, else an agent-root
 *   qualifier, so two `primary` sessions from different projects NEVER collide.
 * - Unparseable ref:              `unparsed:<sanitized>`  label `<raw>`
 *
 * Matching MUST use `tabKey`, never a bare `primary` or a human label.
 */
export function deriveHeadlessTabIdentity(
  scopeRef: string,
  parsed?: ViewerIdentity | undefined
): HeadlessTabIdentity {
  if (parsed === undefined || parsed.kind === 'unparsed') {
    const safe = sanitizeKeyFragment(scopeRef)
    return {
      tabKey: `unparsed:${safe}`,
      agentId: parsed?.agentId ?? 'unknown',
      label: scopeRef || safe,
    }
  }
  const agentId = parsed.agentId
  // Label uses the SHORT project prefix (presentation only); the tabKey keeps the
  // full projectId so topology grouping stays canonical (daedalus C1/C2).
  if (isRealTaskId(parsed.taskId)) {
    const prefix = shortenProjectId(parsed.projectId)
    return {
      tabKey: `task:${parsed.taskId}`,
      agentId,
      taskId: parsed.taskId,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      label: prefix ? `${prefix} · ${parsed.taskId}` : parsed.taskId,
    }
  }
  const qualifier = parsed.projectId
    ? sanitizeKeyFragment(parsed.projectId)
    : `agent-root-${sanitizeKeyFragment(agentId)}`
  const prefix = parsed.projectId ? shortenProjectId(parsed.projectId) : `~${agentId}`
  const scopeToken = parsed.taskId ? sanitizeKeyFragment(parsed.taskId) : 'primary'
  return {
    tabKey: `project:${qualifier}:${scopeToken}`,
    agentId,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    label: `${prefix} · ${scopeToken}`,
  }
}

/**
 * Default window placement for a tab identity (T-07603).
 *
 * Machine-dispatched worker lanes (`task:T-XXXXX`, role-qualified seats
 * included) belong in the headless pile, except chief seats and hcs-project
 * task seats, which share the Chief Contexts window. The hcs board mints those
 * Lance-attention contexts as `<agent>@hcs:T-XXXXX` regardless of the target
 * checkout, so the scope project — not cwd — determines whether a seat is in
 * hcs. The accepted tradeoff is that machine-dispatched implementation workers
 * on hcs-project tasks land there too. Everything else the operator summoned by
 * name — `primary`, roster slugs, `minisvc`/`minilab`, hand-named lanes such as
 * `viewrca` — belongs in the window they are actually working in.
 *
 * The classification is `deriveHeadlessTabIdentity`'s, unchanged: this reads the
 * tabKey it already produced rather than re-testing the scope. So window
 * placement and tab grouping can never disagree, and `isRealTaskId` keeps its
 * single definition.
 *
 * An UNPARSEABLE scope routes to the HEADLESS window. That branch returns before
 * `isRealTaskId` is ever reached, so keying off a bare taskId would send junk
 * panes into the operator's window; malformed input belongs in the background.
 */
export function defaultWindowKeyForTab(tab: HeadlessTabIdentity): string {
  if (tab.tabKey.startsWith('unparsed:')) return DEFAULT_HEADLESS_WINDOW_KEY
  if (tab.agentId === 'chief') return CHIEF_WINDOW_KEY
  if (tab.projectId === 'hcs' && tab.tabKey.startsWith('task:')) return CHIEF_WINDOW_KEY
  if (tab.tabKey.startsWith('task:')) return DEFAULT_HEADLESS_WINDOW_KEY
  return INTERACTIVE_WINDOW_KEY
}

/**
 * Effective window key for a placement. An explicit `--viewer-window` hint always
 * wins; absent a hint the key comes from scope shape (T-07603) instead of always
 * folding to the headless window as it did under T-07118.
 */
export function resolveWindowKey(hint: string | undefined, tab: HeadlessTabIdentity): string {
  const trimmed = (hint ?? '').trim()
  if (trimmed.length > 0) return sanitizeKeyFragment(trimmed)
  return defaultWindowKeyForTab(tab)
}

/**
 * Canonical pane uniqueness key from the full normalized HRC session identity
 * `(scopeRef, laneRef)` (T-06321). A role-qualified scope keeps its `role:` segment
 * and distinct lanes append distinct `lane` refs, so tester/implementer/observer
 * scopes for the same agent+task — and distinct lanes for one scope — never collapse
 * to one pane. Falls back to the sanitized raw ref for an unparseable scope so it
 * never throws.
 */
function deriveHeadlessPaneKey(laneRef: string, scopeRef: string): string {
  return `${scopeRef}#${laneRef}`
}

/**
 * Derive the full headless-viewer session identity (T-06321): the tab grouping
 * (unchanged from T-05237) plus the canonical pane key and normalized lane. Lane
 * identity is threaded from the caller rather than reconstructed/defaulted inside
 * the presentation layer; an omitted lane normalizes to `main`.
 */
export function deriveHeadlessSessionIdentity(
  scopeRef: string,
  laneRef?: string | undefined,
  parsed?: ViewerIdentity | undefined
): HeadlessSessionIdentity {
  const tab = deriveHeadlessTabIdentity(scopeRef, parsed)
  const lane = normalizeLaneRef(laneRef)
  return {
    tab,
    paneKey: deriveHeadlessPaneKey(lane, scopeRef),
    laneRef: lane,
    ...(parsed?.roleName ? { roleName: parsed.roleName } : {}),
  }
}

/** Shipped default pane title; a durable manual/session title may override it. */
export function defaultHeadlessPaneTitle(
  scopeRef: string,
  laneRef?: string | undefined,
  parsed?: ViewerIdentity | undefined
): string {
  const identity = deriveHeadlessSessionIdentity(scopeRef, laneRef, parsed)
  const base = `${identity.tab.label} · ${identity.tab.agentId}`
  return identity.roleName ? `${base} · ${identity.roleName}` : base
}
