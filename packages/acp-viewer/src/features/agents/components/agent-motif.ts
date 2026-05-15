type AgentMotif = 'dots' | 'lines' | 'rules' | 'hatch' | 'chevron' | 'checker'

/**
 * Build a CSS background-image string for an agent's motif, tinted with their
 * signature color. Returned as an SVG data URI so the pattern is inline and
 * crisp at any DPR.
 */
export function motifBackground(motif: AgentMotif, color: string): string {
  const c = encodeURIComponent(color)
  switch (motif) {
    case 'dots':
      // Stippled diagram — engineering blueprint feel.
      return svgUrl(
        24,
        24,
        `<circle cx='12' cy='12' r='1.1' fill='${c}' opacity='0.65'/>` +
          `<circle cx='0' cy='0' r='0.6' fill='${c}' opacity='0.45'/>` +
          `<circle cx='24' cy='24' r='0.6' fill='${c}' opacity='0.45'/>`
      )
    case 'lines':
      // Faint codex column — one whisper-thin rule per 36px.
      return svgUrl(
        36,
        36,
        `<line x1='18' y1='0' x2='18' y2='36' stroke='${c}' stroke-width='0.4' opacity='0.18'/>`
      )
    case 'rules':
      // Sparse manuscript leading — one rule per 28px.
      return svgUrl(
        56,
        28,
        `<line x1='0' y1='14' x2='56' y2='14' stroke='${c}' stroke-width='0.4' opacity='0.18'/>`
      )
    case 'hatch':
      // Diagonal heraldic hatch — engraved.
      return svgUrl(
        14,
        14,
        `<line x1='0' y1='14' x2='14' y2='0' stroke='${c}' stroke-width='0.7' opacity='0.55'/>` +
          `<line x1='-3.5' y1='10.5' x2='3.5' y2='3.5' stroke='${c}' stroke-width='0.7' opacity='0.55'/>` +
          `<line x1='10.5' y1='17.5' x2='17.5' y2='10.5' stroke='${c}' stroke-width='0.7' opacity='0.55'/>`
      )
    case 'chevron':
      // Forward chevrons — flight / motion.
      return svgUrl(
        18,
        12,
        `<polyline points='2,8 6,4 10,8' fill='none' stroke='${c}' stroke-width='0.8' opacity='0.55'/>` +
          `<polyline points='10,8 14,4 18,8' fill='none' stroke='${c}' stroke-width='0.8' opacity='0.55'/>`
      )
    case 'checker': {
      // Test-grid checker — acceptance matrix.
      return svgUrl(
        16,
        16,
        `<rect x='0' y='0' width='8' height='8' fill='${c}' opacity='0.18'/>` +
          `<rect x='8' y='8' width='8' height='8' fill='${c}' opacity='0.18'/>`
      )
    }
    default:
      return 'none'
  }
}

function svgUrl(w: number, h: number, body: string): string {
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${body}</svg>")`
}
