import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  requireNoPositionals,
  requireStringFlag,
} from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'

import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type Delivery = Record<string, unknown>
type DeliveryListResponse = {
  deliveries: Delivery[]
  nextCursor: string | null
}

type DeliveryRetryResponse = {
  delivery: Delivery
}

export async function runDeliveryCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: [
      '--delivery',
      '--gateway',
      '--since',
      '--limit',
      '--requeued-by',
      '--server',
      '--actor',
      '--project',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('delivery help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)
  const requester = createRawRequesterFromParsed(parsed, deps)

  if (subcommand === 'list-failed') {
    const query = new URLSearchParams({ status: 'failed' })
    if (parsed.stringFlags['--gateway'] !== undefined) {
      query.set('gatewayId', requireStringFlag(parsed, '--gateway'))
    }
    if (parsed.stringFlags['--since'] !== undefined) {
      query.set('since', requireStringFlag(parsed, '--since'))
    }
    if (parsed.stringFlags['--limit'] !== undefined) {
      query.set(
        'limit',
        String(parseIntegerValue('--limit', requireStringFlag(parsed, '--limit'), { min: 1 }))
      )
    }

    const response = await requester.requestJson<DeliveryListResponse>({
      method: 'GET',
      path: `/v1/gateway/deliveries?${query.toString()}`,
    })
    return renderJsonOrTable(parsed, response, () => {
      return renderTable(
        [
          { header: 'Delivery', value: (row: Delivery) => String(row['deliveryRequestId'] ?? '') },
          {
            header: 'Code',
            value: (row: Delivery) =>
              String((row['failure'] as Record<string, unknown> | undefined)?.['code'] ?? ''),
          },
          {
            header: 'Message',
            value: (row: Delivery) =>
              String((row['failure'] as Record<string, unknown> | undefined)?.['message'] ?? ''),
          },
        ],
        response.deliveries
      )
    })
  }

  if (subcommand === 'retry') {
    const requeuedBy =
      parsed.stringFlags['--requeued-by'] ??
      parsed.stringFlags['--actor'] ??
      process.env['ACP_ACTOR_AGENT_ID']
    if (requeuedBy === undefined || requeuedBy.trim().length === 0) {
      throw new CliUsageError('delivery retry requires --requeued-by or --actor')
    }

    const response = await requester.requestJson<DeliveryRetryResponse>({
      method: 'POST',
      path: `/v1/gateway/deliveries/${encodeURIComponent(requireStringFlag(parsed, '--delivery'))}/requeue`,
      body: { requeuedBy: requeuedBy.trim() },
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.delivery))
  }

  throw new CliUsageError(`unknown delivery subcommand: ${subcommand}`)
}
