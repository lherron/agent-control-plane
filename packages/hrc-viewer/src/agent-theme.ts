/**
 * Session appearance comes from HRC metadata. Rows without appearance use a
 * deterministic agent-id hash and a dark derived terminal tint.
 */

export type AgentTheme = {
  /** Saturated identity hex for the statusbar bg, e.g. `#6B4FB0`. */
  bg: string
  /** Foreground hex chosen for contrast against `bg`. */
  fg: string
  /**
   * Dark, low-luminance tint of the agent hue for the viewer's TERMINAL
   * background (`ghostmux set-bg`). Distinct from `bg`: this paints behind the
   * live tmux/Claude content, so it is forced into a dark band that keeps the
   * session text readable while still carrying the agent hue (T-04439).
   */
  terminalBg: string
}

/** Dark band the terminal tint is forced into (keeps session text readable). */
const TERMINAL_TINT_LIGHTNESS = 0.14
const TERMINAL_TINT_MAX_SATURATION = 0.5

/** Warm white / near-black — the only two foregrounds we choose between. */
const FG_LIGHT = '#F2EEE6'
const FG_DARK = '#15110C'

/** Saturation/lightness band the hash fallback lives in (keeps identity colors readable). */
const FALLBACK_SATURATION = 0.5
const FALLBACK_LIGHTNESS = 0.42

/** Resolve the generic deterministic theme for an agent id. */
export function agentTheme(agentId: string): AgentTheme {
  const key = agentId.trim().toLowerCase()
  const bg = hashColor(key)
  const terminalBg = terminalTint(bg)
  return { bg, fg: contrastForeground(bg), terminalBg }
}

/** Force a base color into the dark, low-luminance terminal-tint band. */
export function terminalTint(bg: string): string {
  const [h, s] = hexToHsl(bg)
  return hslToHex(h, Math.min(s, TERMINAL_TINT_MAX_SATURATION), TERMINAL_TINT_LIGHTNESS)
}

/** FNV-1a hash of the agent id → hue, fixed S/L → hex. Deterministic. */
function hashColor(agentId: string): string {
  const hue = fnv1a(agentId) % 360
  return hslToHex(hue, FALLBACK_SATURATION, FALLBACK_LIGHTNESS)
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Pick whichever of warm-white / near-black has the higher WCAG contrast. */
export function contrastForeground(bg: string): string {
  return contrastRatio(bg, FG_LIGHT) >= contrastRatio(bg, FG_DARK) ? FG_LIGHT : FG_DARK
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : normalized
  const value = Number.parseInt(full, 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** Per-session cosmetic overrides, independently falling back to the agent hash theme. */
export function sessionTheme(
  identity: { agentId: string } | undefined,
  metadata?: Record<string, unknown> | undefined
): AgentTheme {
  const fallback = agentTheme(identity?.agentId ?? 'unknown')
  const appearance = metadata?.['appearance']
  const values =
    appearance !== null && typeof appearance === 'object' && !Array.isArray(appearance)
      ? (appearance as Record<string, unknown>)
      : {}
  const color = typeof values['color'] === 'string' ? values['color'] : fallback.bg
  return {
    bg: color,
    fg: typeof values['terminalFg'] === 'string' ? values['terminalFg'] : contrastForeground(color),
    terminalBg:
      typeof values['terminalBg'] === 'string' ? values['terminalBg'] : fallback.terminalBg,
  }
}
