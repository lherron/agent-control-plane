import type { DeliveryTarget } from 'acp-core'

import type { BindingRepo } from './repos/binding-repo.js'
import type { LastDeliveryContextRepo } from './repos/last-delivery-context-repo.js'
import type { ResolveDeliveryTargetResult } from './types.js'

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export class DeliveryTargetResolver {
  constructor(
    private readonly deps: {
      bindings: BindingRepo
      lastDeliveryContext: LastDeliveryContextRepo
    }
  ) {}

  resolve(target: DeliveryTarget): ResolveDeliveryTargetResult {
    switch (target.kind) {
      case 'binding': {
        const binding = this.deps.bindings.getById(target.bindingId)
        if (binding === undefined || binding.status !== 'active') {
          return { ok: false, code: 'not_found' }
        }

        return {
          ok: true,
          destination: {
            gatewayId: binding.gatewayId,
            conversationRef: binding.conversationRef,
            ...(binding.threadRef !== undefined ? { threadRef: binding.threadRef } : {}),
          },
        }
      }

      case 'last': {
        const lastDelivery = this.deps.lastDeliveryContext.getLastDelivery(target.sessionRef)
        if (lastDelivery === undefined) {
          return { ok: false, code: 'no_last_context' }
        }

        return {
          ok: true,
          destination: {
            gatewayId: lastDelivery.gatewayId,
            conversationRef: lastDelivery.conversationRef,
            ...(lastDelivery.threadRef !== undefined ? { threadRef: lastDelivery.threadRef } : {}),
          },
        }
      }

      case 'explicit': {
        if (
          !isNonEmptyString(target.gatewayId) ||
          !isNonEmptyString(target.conversationRef) ||
          (target.threadRef !== undefined && !isNonEmptyString(target.threadRef))
        ) {
          return { ok: false, code: 'invalid_target' }
        }

        return {
          ok: true,
          destination: {
            gatewayId: target.gatewayId,
            conversationRef: target.conversationRef,
            ...(target.threadRef !== undefined ? { threadRef: target.threadRef } : {}),
          },
        }
      }
    }
  }
}
