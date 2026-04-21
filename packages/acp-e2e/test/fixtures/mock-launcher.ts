import type { SessionRef } from 'agent-scope'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import type { LaunchRoleScopedRun } from 'acp-server'

export type RecordedLaunch = {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
  runId: string
  sessionId: string
  emit(event: UnifiedSessionEvent): Promise<void>
}

export type RecordingMockLauncher = {
  launches: RecordedLaunch[]
  launchRoleScopedRun: LaunchRoleScopedRun
  last(): RecordedLaunch | undefined
  completeRunWithAssistantMessage(runId: string, text: string): Promise<void>
}

export function createRecordingMockLauncher(): RecordingMockLauncher {
  const launches: RecordedLaunch[] = []

  return {
    launches,
    launchRoleScopedRun: async (input) => {
      const index = (launches.length + 1).toString().padStart(3, '0')
      const runId = `run-tester-${index}`
      const sessionId = `session-tester-${index}`

      launches.push({
        sessionRef: input.sessionRef,
        intent: input.intent,
        runId,
        sessionId,
        async emit(event) {
          await input.onEvent?.(event)
        },
      })

      return {
        runId,
        sessionId,
      }
    },
    last() {
      return launches.at(-1)
    },
    async completeRunWithAssistantMessage(runId, text) {
      const launch = launches.find((entry) => entry.runId === runId)
      if (launch === undefined) {
        throw new Error(`No recorded mock launch found for run ${runId}`)
      }

      await launch.emit({
        type: 'message_end',
        messageId: `assistant-${runId}`,
        message: {
          role: 'assistant',
          content: text,
        },
      })
    },
  }
}
