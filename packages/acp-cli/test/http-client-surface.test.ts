import { describe, expect, test } from 'bun:test'
import { createHttpClient } from '../src/index.js'

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
      'getAgent',
      'getProject',
      'getTask',
      'listAgents',
      'listInterfaceBindings',
      'listMemberships',
      'listProjects',
      'listSystemEvents',
      'patchAgent',
      'patchAgentProfile',
      'postHeartbeatWake',
      'putHeartbeat',
      'registerInterfaceIdentity',
      'setProjectDefaultAgent',
      'transitionTask',
      'upsertInterfaceBinding',
      'waiveObligation',
    ])
  })
})
