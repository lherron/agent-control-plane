export type PbcEffectDeliveryPort = {
  effect: {
    list(params: { task: string }): Promise<unknown>
    deliver(params: { effectId: string; adapter: string }): Promise<unknown>
  }
}

export type EffectDeliveryInput = {
  task: string
  adapter?: string | undefined
  maxEffects?: number | undefined
}

export type EffectDeliverySkipped = {
  effectId: string
  reason: string
}

export type EffectDeliveryResult = {
  delivered: string[]
  skipped: EffectDeliverySkipped[]
}

type ListedEffect = {
  id?: unknown
  effectId?: unknown
  status?: unknown
}

const DEFAULT_ADAPTER = 'acp'
const WRKF_LEASE_CONFLICT = 'WRKF_LEASE_CONFLICT'

export async function deliverPbcEffects(
  port: PbcEffectDeliveryPort,
  input: EffectDeliveryInput
): Promise<EffectDeliveryResult> {
  const adapter = input.adapter ?? DEFAULT_ADAPTER
  const listedEffects = await port.effect.list({ task: input.task })
  const pendingEffects = normalizeEffects(listedEffects)
    .filter((effect) => effect.status === 'pending')
    .slice(0, maxEffectsLimit(input.maxEffects))

  const delivered: string[] = []
  const skipped: EffectDeliverySkipped[] = []

  for (const effect of pendingEffects) {
    const effectId = effectIdFrom(effect)
    if (!effectId) {
      continue
    }

    try {
      await port.effect.deliver({ effectId, adapter })
      delivered.push(effectId)
    } catch (error) {
      if (!isLeaseConflict(error)) {
        throw error
      }
      skipped.push({ effectId, reason: leaseConflictReason(error) })
    }
  }

  return { delivered, skipped }
}

function normalizeEffects(raw: unknown): ListedEffect[] {
  return Array.isArray(raw) ? raw.filter(isListedEffect) : []
}

function isListedEffect(value: unknown): value is ListedEffect {
  return typeof value === 'object' && value !== null
}

function effectIdFrom(effect: ListedEffect): string | undefined {
  if (typeof effect.id === 'string') {
    return effect.id
  }
  if (typeof effect.effectId === 'string') {
    return effect.effectId
  }
  return undefined
}

function maxEffectsLimit(maxEffects: number | undefined): number {
  if (maxEffects === undefined) {
    return Infinity
  }
  return Math.max(0, Math.floor(maxEffects))
}

function isLeaseConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const maybeError = error as { code?: unknown; message?: unknown }
  return (
    maybeError.code === WRKF_LEASE_CONFLICT ||
    (typeof maybeError.message === 'string' && maybeError.message.includes(WRKF_LEASE_CONFLICT))
  )
}

function leaseConflictReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybeError = error as { code?: unknown; message?: unknown }
    if (typeof maybeError.code === 'string') {
      return maybeError.code
    }
    if (typeof maybeError.message === 'string' && maybeError.message.length > 0) {
      return maybeError.message
    }
  }
  return WRKF_LEASE_CONFLICT
}
