import { EXPECTED_CONSUMER_PRODUCERS } from '../packages/acp-server/src/deployment-coherence.js'
import { resolvePublishedManifest } from './advance-producers.js'

const anchors = { asp: 'agent-spaces', hrc: 'hrc-core' } as const

for (const producer of EXPECTED_CONSUMER_PRODUCERS) {
  try {
    const latest = await resolvePublishedManifest(anchors[producer.setName], 'latest')
    console.log(
      `PRODUCER_PINNED ${producer.setName} ${producer.setVersion}@${producer.sourceCommit}; registry latest ${latest.version}@${latest.build.sourceCommit}`
    )
  } catch (error) {
    console.log(
      `PRODUCER_PINNED ${producer.setName} ${producer.setVersion}@${producer.sourceCommit}; registry latest unknown (${String(error)})`
    )
  }
}
