import { deepFreeze } from '../models/preset.js'
import type { Preset } from '../models/preset.js'

const codeDefectFastlanePreset = {
  presetId: 'code_defect_fastlane',
  version: 1,
  kind: 'code_change',
  phaseGraph: ['open', 'red', 'green', 'verified', 'completed'],
  defaultRoles: ['triager', 'implementer', 'tester', 'owner'],
  transitionPolicy: [
    {
      fromPhase: 'open',
      toPhase: 'red',
      allowedRoles: ['triager', 'implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['tdd_red_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'red',
      toPhase: 'green',
      allowedRoles: ['implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['tdd_green_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'green',
      toPhase: 'verified',
      allowedRoles: ['tester', 'implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['qa_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low'],
    },
    {
      fromPhase: 'green',
      toPhase: 'verified',
      allowedRoles: ['tester'],
      disallowSameAgentAsRoles: ['implementer'],
      requiredEvidenceKinds: ['qa_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['medium', 'high'],
    },
    {
      fromPhase: 'verified',
      toPhase: 'completed',
      allowedRoles: ['owner', 'implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: [],
      riskClasses: ['low', 'medium', 'high'],
    },
  ],
  guidance: {
    open: {
      objective: 'Capture a deterministic repro before changing code.',
      doneWhen: ['the failing behavior is pinned', 'the base build or version is recorded'],
      suggestedEvidence: ['tdd_red_bundle'],
      agentHints: [
        'Prefer the smallest reproducible case',
        'Escalate if the defect touches security, billing, or migrations',
      ],
    },
    red: {
      objective: 'Turn the repro into a stable failing proof.',
      doneWhen: [
        'the regression is reproducible on demand',
        'failure evidence is attached to the task',
      ],
      suggestedEvidence: ['tdd_red_bundle'],
      agentHints: [
        'Do not move forward without red proof',
        'Keep the failing case narrow and easy to rerun',
      ],
    },
    green: {
      objective: 'Ship the smallest fix that makes the repro pass.',
      doneWhen: ['the fix is linked to code changes', 'targeted regression proof now passes'],
      suggestedEvidence: ['tdd_green_bundle'],
      agentHints: [
        'Prefer a minimal, local fix',
        'Queue an independent tester when risk is medium or high',
      ],
    },
    verified: {
      objective: 'Confirm the fix on the build under test.',
      doneWhen: [
        'smoke or replay proof passes',
        'verification evidence points at the tested build',
      ],
      suggestedEvidence: ['qa_bundle'],
      agentHints: [
        'Use a distinct tester when risk is not low',
        'Keep the QA bundle lightweight but auditable',
      ],
    },
    completed: {
      objective: 'Close the task with merge or deploy provenance.',
      doneWhen: ['merge or deploy refs are captured', 'the task can be audited end to end'],
      suggestedEvidence: [],
      agentHints: ['Keep the close-out note short and specific'],
    },
  },
} satisfies Preset

export const codeDefectFastlaneV1 = deepFreeze(codeDefectFastlanePreset) as Preset
