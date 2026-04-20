import { listOutboundTransitionRules } from './models/preset.js'
import type { Preset } from './models/preset.js'
import type { Task } from './models/task.js'

const MAX_HINTS_TEXT_LENGTH = 1536

function truncateHintsText(hintsText: string): string {
  if (hintsText.length <= MAX_HINTS_TEXT_LENGTH) {
    return hintsText
  }

  return `${hintsText.slice(0, MAX_HINTS_TEXT_LENGTH - 3)}...`
}

function renderHintsText(input: { phase: string; preset: Preset }): string {
  const guidance = input.preset.guidance[input.phase]
  if (guidance === undefined) {
    return `Phase: ${input.phase}`
  }

  const lines = [`Phase: ${input.phase}`, `Objective: ${guidance.objective}`]

  if (guidance.doneWhen.length > 0) {
    lines.push('Done when:')
    for (const item of guidance.doneWhen) {
      lines.push(`- ${item}`)
    }
  }

  if (guidance.agentHints.length > 0) {
    lines.push('Agent hints:')
    for (const item of guidance.agentHints) {
      lines.push(`- ${item}`)
    }
  }

  return truncateHintsText(lines.join('\n'))
}

export function computeTaskContext(input: {
  preset: Preset
  task: Task
  role: string
}): { phase: string; requiredEvidenceKinds: string[]; hintsText: string } {
  const requiredEvidenceKinds = Array.from(
    new Set(
      listOutboundTransitionRules(input.preset, input.task.phase, input.task.riskClass)
        .filter((rule) => rule.allowedRoles.includes(input.role))
        .flatMap((rule) => rule.requiredEvidenceKinds)
    )
  )

  return {
    phase: input.task.phase,
    requiredEvidenceKinds,
    hintsText: renderHintsText({ phase: input.task.phase, preset: input.preset }),
  }
}
