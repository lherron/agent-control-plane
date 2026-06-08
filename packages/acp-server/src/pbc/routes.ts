/**
 * /v1/pbc/* product facade route handlers (Phase 3, T-02864).
 *
 * Barrel re-export of the PBC product handlers. Registration lives in
 * routing/param-routes.ts (+ mutating specs in routing/mutating-routes.ts).
 */

export { handlePbcStart } from './start.js'
export { handlePbcGetTask } from './get-task.js'
export { handlePbcInput } from './input.js'
export { handlePbcContinue } from './continue.js'
export { handlePbcDispose } from './dispose.js'
export { handlePbcGetJob } from './jobs.js'
export { handlePbcReconcileEffects } from './effects.js'
