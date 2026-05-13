// Re-export from shared package — all adapter logic now lives in hrc-frame-render
export {
  adaptHrcLifecycleEvent,
  canonicalSessionRefFromEvent,
  hrcLifecycleEventToSessionEnvelope,
  type HrcLifecycleEventPayload,
} from 'hrc-frame-render'
