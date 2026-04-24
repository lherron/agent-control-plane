import { type Page, type TestInfo, expect, test } from '@playwright/test'
import type {
  DashboardEvent,
  SessionDashboardSnapshot,
  SessionTimelineRow,
} from 'acp-ops-projection'
import {
  FAMILY_LANES,
  computeTimelineLayout,
  eventToX,
  laneY,
  timelineWindowForEvents,
} from '../src/components/timeline/drawTimeline'

test.describe('Session Dashboard §19.3 visual red tests', () => {
  test.beforeEach(async ({ page }) => {
    await installDashboardRoutes(page)
  })

  test('default live dashboard renders a non-empty temporal canvas', async ({ page }, testInfo) => {
    await page.goto('/')
    await expect(page.getByTestId('status-strip')).toBeVisible()
    await expect(page.getByTestId('session-queue')).toBeVisible()
    await expect(page.getByTestId('temporal-canvas')).toBeVisible()
    await expect(page.getByTestId('event-inspector')).toBeVisible()
    await expect(page.getByTestId('replay-controls')).toBeVisible()
    await expect(page.getByTestId('connection-state')).toHaveText(/connected|replaying/)
    await attachScreenshot(page, testInfo, 'default-live-dashboard')

    const nonBlankPixels = await countNonBlankCanvasPixels(page)
    expect(nonBlankPixels).toBeGreaterThan(0)
  })

  test('paused replay stops the NOW cursor from advancing', async ({ page }, testInfo) => {
    await page.goto('/')
    const canvas = page.getByTestId('temporal-canvas')
    const beforePause = await readNowCursorX(page)

    await page.getByRole('button', { name: 'Pause' }).click()
    await page.waitForTimeout(150)
    const afterPause = await readNowCursorX(page)
    await attachScreenshot(page, testInfo, 'paused-replay-state')

    await expect(page.getByTestId('connection-state')).toHaveText('paused')
    await expect(canvas).toHaveAttribute('data-live-mode', 'paused')
    expect(afterPause).toBe(beforePause)
  })

  test('selecting a bead populates the event envelope inspector', async ({ page }, testInfo) => {
    await page.goto('/')
    await clickTimelineEvent(page, 1003)
    await attachScreenshot(page, testInfo, 'selected-event-inspector')

    const inspector = page.getByTestId('event-inspector')
    await expect(inspector).toContainText('hrcSeq')
    await expect(inspector).toContainText('1003')
    await expect(inspector).toContainText('ts')
    await expect(inspector).toContainText('eventKind')
    await expect(inspector).toContainText('user_input_received')
    await expect(inspector).toContainText('scope-alpha')
    await expect(inspector).toContainText('main')
    await expect(inspector).toContainText('host-session-alpha')
    await expect(inspector).toContainText('generation')
    await expect(inspector).toContainText('payloadPreview')
  })

  test('in-flight input renders a branch that rejoins on applied event', async ({
    page,
  }, testInfo) => {
    await page.goto('/')
    await attachScreenshot(page, testInfo, 'in-flight-input-branch')

    const canvas = page.getByTestId('temporal-canvas')
    await expect(canvas).toHaveAttribute('data-branch-count', '1')
    await expect(canvas).toHaveAttribute('data-rejoin-count', '1')
    expect(await countPixelsMatchingRole(page, 'input')).toBeGreaterThan(0)
  })

  test('stale-context rejection remains visible as a warning bead', async ({ page }, testInfo) => {
    await page.goto('/')
    await clickTimelineEvent(page, 1005)
    await attachScreenshot(page, testInfo, 'stale-context-warning')

    const inspector = page.getByTestId('event-inspector')
    await expect(page.getByTestId('temporal-canvas')).toHaveAttribute('data-warning-count', '1')
    await expect(inspector).toContainText('stale_context_rejected')
    await expect(inspector).toContainText('STALE_CONTEXT')
    await expect(inspector).toContainText('warning')
  })

  test('320px responsive fallback keeps critical controls within the viewport', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await page.goto('/')
    await attachScreenshot(page, testInfo, 'responsive-320px-fallback')

    for (const testId of [
      'status-strip',
      'session-queue',
      'temporal-canvas',
      'event-inspector',
      'replay-controls',
      'connection-state',
    ]) {
      await expect(page.getByTestId(testId)).toBeInViewport()
    }

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
    expect(hasHorizontalOverflow).toBe(false)
  })

  test('reduced-motion mode disables pulses and timeline trail animations', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await attachScreenshot(page, testInfo, 'reduced-motion-mode')

    const canvas = page.getByTestId('temporal-canvas')
    await expect(canvas).toHaveAttribute('data-reduced-motion', 'true')
    await expect(canvas).toHaveAttribute('data-pulse-animation', 'disabled')
    await expect(canvas).toHaveAttribute('data-trail-animation', 'disabled')
  })
})

async function installDashboardRoutes(page: Page) {
  const snapshot = createMockSnapshot()

  await page.route('**/v1/ops/session-dashboard/snapshot**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    })
  })

  await page.route('**/v1/ops/session-dashboard/events**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${snapshot.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    })
  })
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
}

async function countNonBlankCanvasPixels(page: Page): Promise<number> {
  return page.getByTestId('temporal-canvas').evaluate((canvasElement) => {
    const canvas = canvasElement as HTMLCanvasElement
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('2D canvas context unavailable')
    }

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let nonBlankPixels = 0

    for (let offset = 0; offset < data.length; offset += 4) {
      if (
        data[offset] !== 0 ||
        data[offset + 1] !== 0 ||
        data[offset + 2] !== 0 ||
        data[offset + 3] !== 0
      ) {
        nonBlankPixels += 1
      }
    }

    return nonBlankPixels
  })
}

async function readNowCursorX(page: Page): Promise<number> {
  const rawValue = await page.getByTestId('temporal-canvas').getAttribute('data-now-x')
  const value = Number(rawValue)
  expect(Number.isFinite(value)).toBe(true)
  return value
}

async function clickTimelineEvent(page: Page, hrcSeq: number) {
  const events = createMockEvents()
  const event = events.find((candidate) => candidate.hrcSeq === hrcSeq)
  if (!event) throw new Error(`Missing mock event ${hrcSeq}`)

  const canvas = page.getByTestId('temporal-canvas')
  const canvasSize = await canvas.evaluate((canvasElement) => ({
    height: (canvasElement as HTMLCanvasElement).clientHeight,
    width: (canvasElement as HTMLCanvasElement).clientWidth,
  }))
  const timelineWindow = timelineWindowForEvents(
    events,
    '2026-04-23T23:46:00.000Z',
    '2026-04-23T23:47:30.000Z'
  )
  const layout = computeTimelineLayout(
    canvasSize.width,
    canvasSize.height,
    timelineWindow.fromTs,
    timelineWindow.toTs
  )
  const family = FAMILY_LANES.includes(event.family) ? event.family : 'runtime'

  await canvas.click({
    force: true,
    position: {
      x: Math.round(eventToX(event, layout, layout.timelineLeft)),
      y: Math.round(laneY(0, family)),
    },
  })
}

async function countPixelsMatchingRole(page: Page, role: 'input'): Promise<number> {
  const roleColor = role === 'input' ? { red: 167, green: 139, blue: 250 } : unreachableRole(role)

  return page.getByTestId('temporal-canvas').evaluate((canvasElement, expectedColor) => {
    const canvas = canvasElement as HTMLCanvasElement
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('2D canvas context unavailable')
    }

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let matchingPixels = 0

    for (let offset = 0; offset < data.length; offset += 4) {
      const isMatch =
        Math.abs((data[offset] ?? 0) - expectedColor.red) <= 8 &&
        Math.abs((data[offset + 1] ?? 0) - expectedColor.green) <= 8 &&
        Math.abs((data[offset + 2] ?? 0) - expectedColor.blue) <= 8 &&
        (data[offset + 3] ?? 0) > 0

      if (isMatch) {
        matchingPixels += 1
      }
    }

    return matchingPixels
  }, roleColor)
}

function unreachableRole(role: never): never {
  throw new Error(`Unsupported role color: ${role}`)
}

function createMockSnapshot(): SessionDashboardSnapshot {
  const serverTime = '2026-04-23T23:47:30.000Z'
  const events = createMockEvents()

  return {
    serverTime,
    generatedAt: serverTime,
    window: {
      fromTs: '2026-04-23T23:46:00.000Z',
      toTs: serverTime,
      fromHrcSeq: 1000,
      toHrcSeq: 1006,
    },
    cursors: {
      nextFromSeq: 1007,
      lastHrcSeq: 1006,
      lastStreamSeq: 506,
    },
    summary: {
      counts: {
        busy: 1,
        idle: 0,
        launching: 0,
        stale: 1,
        dead: 0,
        inFlightInputs: 1,
        deliveryPending: 1,
      },
      eventRatePerMinute: 1842,
      streamLagMs: 38,
      droppedEvents: 0,
      reconnectCount: 0,
    },
    sessions: [createMockSession()],
    events,
  }
}

function createMockSession(): SessionTimelineRow {
  return {
    rowId: 'host-session-alpha:2',
    sessionRef: {
      scopeRef: 'scope-alpha',
      laneRef: 'main',
    },
    hostSessionId: 'host-session-alpha',
    generation: 2,
    runtime: {
      runtimeId: 'runtime-alpha',
      launchId: 'launch-alpha',
      transport: 'tmux',
      harness: 'codex',
      provider: 'openai',
      status: 'busy',
      supportsInFlightInput: true,
      activeRunId: 'run-alpha',
      lastActivityAt: '2026-04-23T23:47:24.000Z',
    },
    acp: {
      latestRunId: 'run-alpha',
      inputAttemptId: 'input-attempt-alpha',
      taskId: 'T-01202',
      workflowPreset: 'session-dashboard',
      deliveryPending: true,
    },
    visualState: {
      priority: 1,
      colorRole: 'input',
      continuity: 'blocked',
    },
    stats: {
      eventsInWindow: 7,
      eventsPerMinute: 1842,
      lastEventAt: '2026-04-23T23:47:24.000Z',
    },
  }
}

function createMockEvents(): DashboardEvent[] {
  return [
    dashboardEvent({
      hrcSeq: 1001,
      streamSeq: 501,
      ts: '2026-04-23T23:46:04.000Z',
      eventKind: 'runtime.started',
      category: 'runtime',
      family: 'runtime',
      severity: 'success',
      label: 'Runtime started',
      payloadPreview: { runtimeId: 'runtime-alpha' },
    }),
    dashboardEvent({
      hrcSeq: 1002,
      streamSeq: 502,
      ts: '2026-04-23T23:46:11.000Z',
      eventKind: 'turn.accepted',
      category: 'turn',
      family: 'runtime',
      severity: 'info',
      label: 'Turn accepted',
      payloadPreview: { runId: 'run-alpha' },
    }),
    dashboardEvent({
      hrcSeq: 1003,
      streamSeq: 503,
      ts: '2026-04-23T23:46:18.000Z',
      eventKind: 'user_input_received',
      category: 'inflight',
      family: 'input',
      severity: 'info',
      label: 'Input received',
      payloadPreview: { inputAttemptId: 'input-attempt-alpha', preview: 'please continue' },
    }),
    dashboardEvent({
      hrcSeq: 1004,
      streamSeq: 504,
      ts: '2026-04-23T23:46:28.000Z',
      eventKind: 'user_input_applied_in_flight',
      category: 'inflight',
      family: 'input',
      severity: 'success',
      label: 'Input applied in-flight',
      payloadPreview: { inputAttemptId: 'input-attempt-alpha', branch: 'rejoined' },
    }),
    dashboardEvent({
      hrcSeq: 1005,
      streamSeq: 505,
      ts: '2026-04-23T23:46:44.000Z',
      eventKind: 'stale_context_rejected',
      category: 'context',
      family: 'warning',
      severity: 'warning',
      label: 'Stale context rejected',
      payloadPreview: {
        errorCode: 'STALE_CONTEXT',
        expectedHostSessionId: 'host-session-alpha',
        expectedGeneration: 2,
      },
    }),
    dashboardEvent({
      hrcSeq: 1006,
      streamSeq: 506,
      ts: '2026-04-23T23:47:24.000Z',
      eventKind: 'delivery.pending',
      category: 'bridge',
      family: 'delivery',
      severity: 'info',
      label: 'Delivery pending',
      payloadPreview: { gatewayId: 'discord', deliveryId: 'delivery-alpha' },
    }),
  ]
}

function dashboardEvent(
  event: Omit<DashboardEvent, 'id' | 'sessionRef' | 'hostSessionId' | 'generation' | 'redacted'>
): DashboardEvent {
  return {
    id: `hrc:${event.hrcSeq}`,
    sessionRef: {
      scopeRef: 'scope-alpha',
      laneRef: 'main',
    },
    hostSessionId: 'host-session-alpha',
    generation: 2,
    redacted: false,
    ...event,
  }
}
