/**
 * `acp mobile ...` — the operator surface for mobile bearer auth
 * (spec `docs/mobile-surface-bearer-auth-spec.md` §2/§4).
 *
 * Every subcommand here is a thin call to a loopback-only admin route. The CLI
 * deliberately does NOT touch `mobile-auth.json`: **the server is that file's only
 * writer**, so minting a code, revoking a device, and arming enforcement all go
 * through the daemon. Running these from a non-loopback peer gets 404 not_local —
 * a bearer token never substitutes for operator locality.
 */

import { CliUsageError } from '../cli-runtime.js'
import { AcpClientHttpError } from '../http-client.js'

import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from './options.js'
import { createRawRequesterFromParsed, renderJsonOrTable } from './shared.js'

import type { CommandDependencies, CommandOutput } from './shared.js'

type MobileAuthDevice = {
  deviceId: string
  deviceName?: string | undefined
  pairedAt: string
}

type MobileAuthStateResponse = {
  enforce: boolean
  devices: MobileAuthDevice[]
}

type MintPairingCodeResponse = {
  code: string
  expiresAt: string
}

function renderDevices(response: MobileAuthStateResponse): string {
  const lines = [`enforce: ${response.enforce ? 'ON' : 'off (dark)'}`]
  if (response.devices.length === 0) {
    lines.push('no paired devices')
    return lines.join('\n')
  }

  lines.push('', 'DEVICE ID     PAIRED AT                 NAME')
  for (const device of response.devices) {
    lines.push(
      `${device.deviceId.padEnd(13)} ${device.pairedAt.padEnd(25)} ${device.deviceName ?? '-'}`
    )
  }
  return lines.join('\n')
}

export async function runMobileCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const [group, subcommand] = args
  const rest = args.slice(group === 'pairing-code' ? 1 : 2)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table', '--force'],
    stringFlags: ['--server', '--actor', '--device'],
  })
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)

  if (group === 'pairing-code') {
    const response = await requester.requestJson<MintPairingCodeResponse>({
      method: 'POST',
      path: '/v1/mobile/auth/pairing-code',
    })
    return renderJsonOrTable(parsed, response, () =>
      [
        `pairing code: ${response.code}`,
        `expires at:   ${response.expiresAt}`,
        '',
        'Enter this code in the mobile client to pair it. Single use; minting another voids it.',
      ].join('\n')
    )
  }

  if (group === 'devices') {
    if (subcommand === 'list') {
      const response = await requester.requestJson<MobileAuthStateResponse>({
        method: 'GET',
        path: '/v1/mobile/auth/devices',
      })
      return renderJsonOrTable(parsed, response, () => renderDevices(response))
    }

    if (subcommand === 'revoke') {
      const response = await requester.requestJson<
        MobileAuthStateResponse & { revoked: MobileAuthDevice }
      >({
        method: 'POST',
        path: '/v1/mobile/auth/devices/revoke',
        body: { deviceId: requireStringFlag(parsed, '--device') },
      })
      return renderJsonOrTable(parsed, response, () =>
        [`revoked ${response.revoked.deviceId}`, '', renderDevices(response)].join('\n')
      )
    }

    throw new CliUsageError(`unknown mobile devices subcommand: ${subcommand}`)
  }

  if (group === 'auth') {
    if (subcommand === 'status') {
      const response = await requester.requestJson<MobileAuthStateResponse>({
        method: 'GET',
        path: '/v1/mobile/auth/devices',
      })
      return renderJsonOrTable(parsed, response, () => renderDevices(response))
    }

    if (subcommand === 'enable' || subcommand === 'disable') {
      const enforce = subcommand === 'enable'
      try {
        const response = await requester.requestJson<MobileAuthStateResponse>({
          method: 'POST',
          path: '/v1/mobile/auth/enforce',
          body: { enforce, ...(hasFlag(parsed, '--force') ? { force: true } : {}) },
        })
        return renderJsonOrTable(parsed, response, () => renderDevices(response))
      } catch (error) {
        // The lockout guard (spec §8) is an operator decision, not a transport
        // failure — surface it as usage guidance rather than a stack trace.
        if (error instanceof AcpClientHttpError && error.status === 409) {
          throw new CliUsageError(
            'refusing to enable mobile bearer enforcement with no paired devices: every non-loopback client would be locked out until a device pairs. Pair one with `acp mobile pairing-code`, or re-run with --force.'
          )
        }
        throw error
      }
    }

    throw new CliUsageError(`unknown mobile auth subcommand: ${subcommand}`)
  }

  throw new CliUsageError(`unknown mobile subcommand: ${group}`)
}
