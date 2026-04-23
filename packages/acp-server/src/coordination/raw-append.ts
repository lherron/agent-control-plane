import {
  type AppendEventCommand,
  type AppendEventResult,
  appendEvent,
} from 'coordination-substrate'
import type { CoordinationStore } from 'coordination-substrate'

export function appendRawCoordinationMessage(
  coordStore: CoordinationStore,
  command: AppendEventCommand
): AppendEventResult {
  return appendEvent(coordStore, command)
}
