import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHttpClient } from '../src/index.js'

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...sourceFilesUnder(fullPath))
      continue
    }
    if (entry.endsWith('.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

describe('AcpClient public surface', () => {
  test('pins the exported client method set', () => {
    expect(Object.keys(createHttpClient()).sort()).toEqual([
      'addEvidence',
      'addMembership',
      'appendSystemEvent',
      'cancelObligation',
      'createAgent',
      'createAgentPulpitMessage',
      'createProject',
      'createTask',
      'getAgent',
      'getProject',
      'getTask',
      'listAgents',
      'listInterfaceBindings',
      'listMemberships',
      'listProjects',
      'listSystemEvents',
      'listTransitions',
      'patchAgent',
      'patchAgentProfile',
      'postHeartbeatWake',
      'promoteTask',
      'putHeartbeat',
      'registerInterfaceIdentity',
      'setProjectDefaultAgent',
      'transitionTask',
      'upsertInterfaceBinding',
      'waiveObligation',
    ])
  })

  test('guards the currently unused task-creation and legacy transition methods from command use', () => {
    const commandSources = sourceFilesUnder(new URL('../src/commands', import.meta.url).pathname)
    const references = commandSources.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return ['createTask', 'promoteTask', 'listTransitions']
        .filter((method) => source.includes(method))
        .map((method) => `${file}:${method}`)
    })

    expect(references).toEqual([])
  })
})
