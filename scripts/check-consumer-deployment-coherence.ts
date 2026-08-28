import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import {
  type ConsumerDeploymentReport,
  type ConsumerLockSelection,
  evaluateConsumerDeployment,
  listConsumerLockSelections,
  readConsumerDeploymentInputs,
} from '../packages/acp-server/src/deployment-coherence.js'

const root = resolve(import.meta.dir, '..')
const jsonMode = Bun.argv.includes('--json')
const fetchMode = Bun.argv.includes('--fetch')
const readbackIndex = Bun.argv.indexOf('--readback-url')
const readbackUrl = readbackIndex >= 0 ? Bun.argv[readbackIndex + 1] : undefined

if (readbackIndex >= 0 && readbackUrl === undefined) {
  throw new Error('--readback-url requires an ACP base URL or endpoint URL')
}

const inputs = await readConsumerDeploymentInputs(root)
let report: ConsumerDeploymentReport = evaluateConsumerDeployment(inputs)
const fetches: ConsumerLockSelection[] = []

if (report.ok && fetchMode) {
  for (const [index, selection] of listConsumerLockSelections(
    inputs.lockText,
    inputs.installed
  ).entries()) {
    const url = new URL(selection.tarball)
    url.searchParams.set('praesidium-cache-empty', `${Date.now()}-${process.pid}-${index}`)
    const response = await fetch(url, {
      headers: {
        'cache-control': 'no-cache, no-store',
        pragma: 'no-cache',
      },
    })
    if (!response.ok) {
      throw new Error(
        `${selection.lockKey} (${selection.name}@${selection.version}): cache-empty fetch returned ${response.status}`
      )
    }
    const digest = `sha512-${createHash('sha512')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('base64')}`
    if (digest !== selection.integrity) {
      throw new Error(
        `${selection.lockKey} (${selection.name}@${selection.version}): fetched integrity ${digest} != lock ${selection.integrity}`
      )
    }
    fetches.push(selection)
  }
}

if (readbackUrl !== undefined) {
  const url = readbackUrl.endsWith('/v1/admin/deployment-coherence')
    ? readbackUrl
    : `${readbackUrl.replace(/\/$/, '')}/v1/admin/deployment-coherence`
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache, no-store', pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`ACP deployment readback returned ${response.status}`)
  report = (await response.json()) as ConsumerDeploymentReport
}

if (jsonMode) {
  console.log(JSON.stringify({ ...report, cacheEmptyFetches: fetches }, null, 2))
} else if (!report.ok) {
  for (const finding of report.findings) console.error(`consumer-deployment: ${finding}`)
} else {
  const suffix = fetchMode ? `; ${fetches.length} cache-empty tarballs verified` : ''
  const readback = readbackUrl !== undefined ? '; served ACP/HRC readback verified' : ''
  console.log(`consumer-deployment: ASP/HRC lock and installed tuples pass${suffix}${readback}`)
}

if (!report.ok) process.exit(1)
