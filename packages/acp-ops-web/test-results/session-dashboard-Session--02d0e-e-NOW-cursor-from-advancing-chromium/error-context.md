# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: session-dashboard.spec.ts >> Session Dashboard §19.3 visual red tests >> paused replay stops the NOW cursor from advancing
- Location: tests/session-dashboard.spec.ts:34:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 536
```

# Page snapshot

```yaml
- main "ACP session dashboard" [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - strong [ref=e6]: ⌁ ACP/HRC
      - emphasis [ref=e7]: Live Ops
    - heading "In-Flight Sessions" [level=1] [ref=e9]
    - generic [ref=e10]:
      - generic [ref=e11]: UTC 18:47:30
      - generic [ref=e12]: Live
      - generic [ref=e13]:
        - text: Auto-refresh
        - combobox "auto-refresh" [ref=e14]:
          - option "ON" [selected]
          - option "OFF"
      - button "▷ Replay" [ref=e15] [cursor=pointer]
      - button "display settings" [ref=e16] [cursor=pointer]: ☷
      - button "confirm view" [ref=e17] [cursor=pointer]: ✓
  - navigation "dashboard navigation" [ref=e18]:
    - button "Overview" [ref=e19] [cursor=pointer]: Overview
    - button "Sessions" [ref=e21] [cursor=pointer]: Sessions
    - button "Events" [ref=e23] [cursor=pointer]: Events
    - button "Runs" [ref=e25] [cursor=pointer]: Runs
    - button "Tools" [ref=e27] [cursor=pointer]: Tools
    - button "Handoffs" [ref=e29] [cursor=pointer]: Handoffs
    - button "Alerts 3" [ref=e31] [cursor=pointer]:
      - text: Alerts
      - emphasis [ref=e33]: "3"
    - button "Settings" [ref=e34] [cursor=pointer]: Settings
    - button "collapse navigation" [ref=e36] [cursor=pointer]: »
  - region "status strip" [ref=e37]:
    - generic [ref=e38]:
      - generic [ref=e40]: Busy
      - strong [ref=e41]: "1"
      - img [ref=e42]
    - generic [ref=e44]:
      - generic [ref=e46]: Idle
      - strong [ref=e47]: "0"
      - img [ref=e48]
    - generic [ref=e50]:
      - generic [ref=e52]: Launching
      - strong [ref=e53]: "0"
      - img [ref=e54]
    - generic [ref=e56]:
      - generic [ref=e58]: Stale
      - strong [ref=e59]: "1"
      - img [ref=e60]
    - generic [ref=e62]:
      - generic [ref=e64]: In-flight inputs
      - strong [ref=e65]: "1"
      - img [ref=e66]
    - generic [ref=e68]:
      - generic [ref=e70]: Stream lag
      - strong [ref=e71]: 38ms
      - img [ref=e72]
  - complementary "session queue" [ref=e74]:
    - generic [ref=e75]:
      - heading "Session Queue" [level=2] [ref=e76]
      - generic [ref=e77]: 1 Active
      - button "filter sessions" [ref=e78] [cursor=pointer]: ⌁
    - list [ref=e79]:
      - listitem [ref=e80]:
        - button "stale 134:27:12 scope-alpha host-se• alpha• gen 2" [ref=e81] [cursor=pointer]:
          - generic [ref=e83]:
            - strong [ref=e84]: stale
            - time [ref=e85]: 134:27:12
          - generic "scope-alpha" [ref=e86]
          - generic [ref=e87]:
            - generic [ref=e88]: host-se•
            - generic [ref=e89]: alpha•
            - generic [ref=e90]: gen 2
    - button "View all sessions →" [ref=e91] [cursor=pointer]:
      - text: View all sessions
      - generic [ref=e92]: →
  - region "temporal session timeline" [ref=e93]:
    - generic [ref=e94]:
      - heading "Timeline/ Selected" [level=2] [ref=e95]
      - generic [ref=e96]:
        - generic [ref=e97]: 1 lane · 6 events
        - generic [ref=e98]:
          - text: Scale
          - combobox "timeline scale" [ref=e99]:
            - option "1m" [selected]
            - option "5m"
        - button "Fit" [ref=e100] [cursor=pointer]
        - button "zoom timeline" [ref=e101] [cursor=pointer]: ↔
        - button "expand timeline" [ref=e102] [cursor=pointer]: ↗
    - generic "temporal canvas" [ref=e103]
    - region "selected session event stream" [ref=e104]:
      - generic [ref=e105]:
        - strong [ref=e106]: Event Stream
        - generic [ref=e107]: 6 loaded
      - list [ref=e108]:
        - listitem [ref=e109]:
          - 'button "18:46:04 1001 Runtime started runtime.started { \"runtimeId\": \"runtime-alpha\" }" [ref=e110] [cursor=pointer]':
            - time [ref=e111]: 18:46:04
            - generic [ref=e112]: "1001"
            - strong [ref=e113]: Runtime started
            - emphasis [ref=e114]: runtime.started
            - paragraph [ref=e115]: "{ \"runtimeId\": \"runtime-alpha\" }"
        - listitem [ref=e116]:
          - 'button "18:46:11 1002 Turn accepted turn.accepted { \"runId\": \"run-alpha\" }" [ref=e117] [cursor=pointer]':
            - time [ref=e118]: 18:46:11
            - generic [ref=e119]: "1002"
            - strong [ref=e120]: Turn accepted
            - emphasis [ref=e121]: turn.accepted
            - paragraph [ref=e122]: "{ \"runId\": \"run-alpha\" }"
        - listitem [ref=e123]:
          - button "18:46:18 1003 Input received user_input_received please continue" [ref=e124] [cursor=pointer]:
            - time [ref=e125]: 18:46:18
            - generic [ref=e126]: "1003"
            - strong [ref=e127]: Input received
            - emphasis [ref=e128]: user_input_received
            - paragraph [ref=e129]: please continue
        - listitem [ref=e130]:
          - 'button "18:46:28 1004 Input applied in-flight user_input_applied_in_flight { \"inputAttemptId\": \"input-attempt-alpha\", \"branch\": \"rejoined\" }" [ref=e131] [cursor=pointer]':
            - time [ref=e132]: 18:46:28
            - generic [ref=e133]: "1004"
            - strong [ref=e134]: Input applied in-flight
            - emphasis [ref=e135]: user_input_applied_in_flight
            - paragraph [ref=e136]: "{ \"inputAttemptId\": \"input-attempt-alpha\", \"branch\": \"rejoined\" }"
        - listitem [ref=e137]:
          - 'button "18:46:44 1005 Stale context rejected stale_context_rejected { \"errorCode\": \"STALE_CONTEXT\", \"expectedHostSessionId\": \"host-session-alpha\", \"expectedGeneration\": 2 }" [ref=e138] [cursor=pointer]':
            - time [ref=e139]: 18:46:44
            - generic [ref=e140]: "1005"
            - strong [ref=e141]: Stale context rejected
            - emphasis [ref=e142]: stale_context_rejected
            - paragraph [ref=e143]: "{ \"errorCode\": \"STALE_CONTEXT\", \"expectedHostSessionId\": \"host-session-alpha\", \"expectedGeneration\": 2 }"
        - listitem [ref=e144]:
          - 'button "18:47:24 1006 Delivery pending delivery.pending { \"gatewayId\": \"discord\", \"deliveryId\": \"delivery-alpha\" }" [ref=e145] [cursor=pointer]':
            - time [ref=e146]: 18:47:24
            - generic [ref=e147]: "1006"
            - strong [ref=e148]: Delivery pending
            - emphasis [ref=e149]: delivery.pending
            - paragraph [ref=e150]: "{ \"gatewayId\": \"discord\", \"deliveryId\": \"delivery-alpha\" }"
  - complementary "event inspector" [ref=e151]:
    - heading "Event Detail" [level=2] [ref=e153]
    - region "selected event details" [ref=e157]:
      - generic [ref=e158]:
        - strong [ref=e160]: scope-alpha / main
        - button "close selected event" [ref=e161] [cursor=pointer]: ×
      - navigation "event detail sections" [ref=e162]:
        - generic [ref=e163]: Details
        - generic [ref=e164]: Input Queue
        - generic [ref=e165]: Tools
        - generic [ref=e166]: Fence
        - generic [ref=e167]: Warnings
      - generic [ref=e168]:
        - generic [ref=e169]:
          - term [ref=e170]: hrcSeq
          - definition [ref=e171]: "1001"
          - term [ref=e172]: streamSeq
          - definition [ref=e173]: "501"
          - term [ref=e174]: ts
          - definition [ref=e175]: 2026-04-23T23:46:04.000Z
          - term [ref=e176]: category
          - definition [ref=e177]: runtime
          - term [ref=e178]: eventKind
          - definition [ref=e179]: runtime.started
          - term [ref=e180]: scopeRef
          - definition [ref=e181]: scope-alpha
          - term [ref=e182]: laneRef
          - definition [ref=e183]: main
          - term [ref=e184]: hostSessionId
          - definition [ref=e185]: host-session-alpha
          - term [ref=e186]: generation
          - definition [ref=e187]: "2"
          - term [ref=e188]: family
          - definition [ref=e189]: runtime
          - term [ref=e190]: severity
          - definition [ref=e191]: success
          - term [ref=e192]: payloadPreview
          - definition [ref=e193]:
            - generic [ref=e194]: "{ \"runtimeId\": \"runtime-alpha\" }"
        - complementary [ref=e195]:
          - generic [ref=e196]:
            - heading "Session Envelope" [level=3] [ref=e197]
            - paragraph [ref=e198]:
              - strong [ref=e199]: host-session-alpha
              - text: generation 2
          - generic [ref=e200]:
            - heading "Runtime" [level=3] [ref=e201]
            - paragraph [ref=e202]: No runtime id on event.
  - region "replay controls" [ref=e203]:
    - group "mode" [ref=e204]:
      - generic [ref=e205]: mode
      - button "Live" [ref=e206] [cursor=pointer]
      - button "Pause" [active] [ref=e207] [cursor=pointer]
    - generic [ref=e208]:
      - text: fromSeq
      - textbox "fromSeq" [ref=e209]: "1"
    - generic [ref=e210]:
      - text: window
      - combobox "loaded time window" [ref=e211]:
        - option "30s"
        - option "90s" [selected]
        - option "5m"
    - generic [ref=e212]:
      - text: speed
      - combobox "playback speed" [ref=e213]:
        - option "0.5x"
        - option "1x" [selected]
        - option "2x"
    - generic [ref=e214]:
      - text: family
      - combobox "event family filter" [ref=e215]:
        - option "all" [selected]
        - option "runtime"
        - option "agent_message"
        - option "tool"
        - option "input"
        - option "delivery"
        - option "handoff"
        - option "surface"
        - option "context"
        - option "warning"
    - generic [ref=e216]:
      - checkbox "high contrast" [ref=e217]
      - text: high contrast
    - generic [ref=e218]: dropped 0
    - generic [ref=e219]: reconnects 1
    - generic [ref=e220]: heartbeat 2026-04-23T23:47:24.000Z
    - status [ref=e221]: paused
    - generic [ref=e222]:
      - text: Stream lag
      - strong [ref=e223]: 38ms
    - generic [ref=e224]:
      - text: Events/sec
      - strong [ref=e225]: 1,842
    - generic [ref=e226]:
      - text: Throughput
      - strong [ref=e227]: 12.4 MB/s
```

# Test source

```ts
  1   | import { type Page, type TestInfo, expect, test } from '@playwright/test'
  2   | import type {
  3   |   DashboardEvent,
  4   |   SessionDashboardSnapshot,
  5   |   SessionTimelineRow,
  6   | } from 'acp-ops-projection'
  7   | import {
  8   |   FAMILY_LANES,
  9   |   computeTimelineLayout,
  10  |   eventToX,
  11  |   laneY,
  12  |   timelineWindowForEvents,
  13  | } from '../src/components/timeline/drawTimeline'
  14  | 
  15  | test.describe('Session Dashboard §19.3 visual red tests', () => {
  16  |   test.beforeEach(async ({ page }) => {
  17  |     await installDashboardRoutes(page)
  18  |   })
  19  | 
  20  |   test('default live dashboard renders a non-empty temporal canvas', async ({ page }, testInfo) => {
  21  |     await page.goto('/')
  22  |     await expect(page.getByTestId('status-strip')).toBeVisible()
  23  |     await expect(page.getByTestId('session-queue')).toBeVisible()
  24  |     await expect(page.getByTestId('temporal-canvas')).toBeVisible()
  25  |     await expect(page.getByTestId('event-inspector')).toBeVisible()
  26  |     await expect(page.getByTestId('replay-controls')).toBeVisible()
  27  |     await expect(page.getByTestId('connection-state')).toHaveText(/connected|replaying/)
  28  |     await attachScreenshot(page, testInfo, 'default-live-dashboard')
  29  | 
  30  |     const nonBlankPixels = await countNonBlankCanvasPixels(page)
  31  |     expect(nonBlankPixels).toBeGreaterThan(0)
  32  |   })
  33  | 
  34  |   test('paused replay stops the NOW cursor from advancing', async ({ page }, testInfo) => {
  35  |     await page.goto('/')
  36  |     const canvas = page.getByTestId('temporal-canvas')
  37  |     const beforePause = await readNowCursorX(page)
  38  | 
  39  |     await page.getByRole('button', { name: 'Pause' }).click()
  40  |     await page.waitForTimeout(150)
  41  |     const afterPause = await readNowCursorX(page)
  42  |     await attachScreenshot(page, testInfo, 'paused-replay-state')
  43  | 
  44  |     await expect(page.getByTestId('connection-state')).toHaveText('paused')
  45  |     await expect(canvas).toHaveAttribute('data-live-mode', 'paused')
> 46  |     expect(afterPause).toBe(beforePause)
      |                        ^ Error: expect(received).toBe(expected) // Object.is equality
  47  |   })
  48  | 
  49  |   test('selecting a bead populates the event envelope inspector', async ({ page }, testInfo) => {
  50  |     await page.goto('/')
  51  |     await clickTimelineEvent(page, 1003)
  52  |     await attachScreenshot(page, testInfo, 'selected-event-inspector')
  53  | 
  54  |     const inspector = page.getByTestId('event-inspector')
  55  |     await expect(inspector).toContainText('hrcSeq')
  56  |     await expect(inspector).toContainText('1003')
  57  |     await expect(inspector).toContainText('ts')
  58  |     await expect(inspector).toContainText('eventKind')
  59  |     await expect(inspector).toContainText('user_input_received')
  60  |     await expect(inspector).toContainText('scope-alpha')
  61  |     await expect(inspector).toContainText('main')
  62  |     await expect(inspector).toContainText('host-session-alpha')
  63  |     await expect(inspector).toContainText('generation')
  64  |     await expect(inspector).toContainText('payloadPreview')
  65  |   })
  66  | 
  67  |   test('in-flight input renders a branch that rejoins on applied event', async ({
  68  |     page,
  69  |   }, testInfo) => {
  70  |     await page.goto('/')
  71  |     await attachScreenshot(page, testInfo, 'in-flight-input-branch')
  72  | 
  73  |     const canvas = page.getByTestId('temporal-canvas')
  74  |     await expect(canvas).toHaveAttribute('data-branch-count', '1')
  75  |     await expect(canvas).toHaveAttribute('data-rejoin-count', '1')
  76  |     expect(await countPixelsMatchingRole(page, 'input')).toBeGreaterThan(0)
  77  |   })
  78  | 
  79  |   test('stale-context rejection remains visible as a warning bead', async ({ page }, testInfo) => {
  80  |     await page.goto('/')
  81  |     await clickTimelineEvent(page, 1005)
  82  |     await attachScreenshot(page, testInfo, 'stale-context-warning')
  83  | 
  84  |     const inspector = page.getByTestId('event-inspector')
  85  |     await expect(page.getByTestId('temporal-canvas')).toHaveAttribute('data-warning-count', '1')
  86  |     await expect(inspector).toContainText('stale_context_rejected')
  87  |     await expect(inspector).toContainText('STALE_CONTEXT')
  88  |     await expect(inspector).toContainText('warning')
  89  |   })
  90  | 
  91  |   test('320px responsive fallback keeps critical controls within the viewport', async ({
  92  |     page,
  93  |   }, testInfo) => {
  94  |     await page.setViewportSize({ width: 320, height: 720 })
  95  |     await page.goto('/')
  96  |     await attachScreenshot(page, testInfo, 'responsive-320px-fallback')
  97  | 
  98  |     for (const testId of [
  99  |       'status-strip',
  100 |       'session-queue',
  101 |       'temporal-canvas',
  102 |       'event-inspector',
  103 |       'replay-controls',
  104 |       'connection-state',
  105 |     ]) {
  106 |       await expect(page.getByTestId(testId)).toBeInViewport()
  107 |     }
  108 | 
  109 |     const hasHorizontalOverflow = await page.evaluate(
  110 |       () => document.documentElement.scrollWidth > window.innerWidth
  111 |     )
  112 |     expect(hasHorizontalOverflow).toBe(false)
  113 |   })
  114 | 
  115 |   test('reduced-motion mode disables pulses and timeline trail animations', async ({
  116 |     page,
  117 |   }, testInfo) => {
  118 |     await page.emulateMedia({ reducedMotion: 'reduce' })
  119 |     await page.goto('/')
  120 |     await attachScreenshot(page, testInfo, 'reduced-motion-mode')
  121 | 
  122 |     const canvas = page.getByTestId('temporal-canvas')
  123 |     await expect(canvas).toHaveAttribute('data-reduced-motion', 'true')
  124 |     await expect(canvas).toHaveAttribute('data-pulse-animation', 'disabled')
  125 |     await expect(canvas).toHaveAttribute('data-trail-animation', 'disabled')
  126 |   })
  127 | })
  128 | 
  129 | async function installDashboardRoutes(page: Page) {
  130 |   const snapshot = createMockSnapshot()
  131 | 
  132 |   await page.route('**/v1/ops/session-dashboard/snapshot**', async (route) => {
  133 |     await route.fulfill({
  134 |       status: 200,
  135 |       contentType: 'application/json',
  136 |       body: JSON.stringify(snapshot),
  137 |     })
  138 |   })
  139 | 
  140 |   await page.route('**/v1/ops/session-dashboard/events**', async (route) => {
  141 |     await route.fulfill({
  142 |       status: 200,
  143 |       contentType: 'application/x-ndjson',
  144 |       body: `${snapshot.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  145 |     })
  146 |   })
```