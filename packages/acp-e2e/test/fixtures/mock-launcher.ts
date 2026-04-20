import type { SessionRef } from 'agent-scope'
import type { HrcRuntimeIntent } from 'hrc-core'

import type { LaunchRoleScopedRun } from 'acp-server'

export type RecordedLaunch = {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
}

export type RecordingMockLauncher = {
  launches: RecordedLaunch[]
  launchRoleScopedRun: LaunchRoleScopedRun
  last(): RecordedLaunch | undefined
}

export function createRecordingMockLauncher(): RecordingMockLauncher {
  const launches: RecordedLaunch[] = []

  return {
    launches,
    launchRoleScopedRun: async (input) => {
      launches.push({
        sessionRef: input.sessionRef,
        intent: input.intent,
      })

      const index = launches.length.toString().padStart(3, '0')
      return {
        runId: `run-tester-${index}`,
        sessionId: `session-tester-${index}`,
      }
    },
    last() {
      return launches.at(-1)
    },
  }
}
