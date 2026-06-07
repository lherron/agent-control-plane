import { PageHeader } from '@/components/page-header'
import { useMobileDashboard } from '@/features/sessions/hooks/use-mobile-dashboard'
import { useMemo } from 'react'
import { EventInspector } from '../components/event-inspector'
import { EventList } from '../components/event-list'
import { SessionControls } from '../components/session-controls'
import { SessionQueue } from '../components/session-queue'
import { StatusStrip } from '../components/status-strip'

export function SessionsLive() {
  const dashboard = useMobileDashboard()
  const selectedEvent = useMemo(
    () => dashboard.events.find((event) => event.id === dashboard.selectedEventId),
    [dashboard.events, dashboard.selectedEventId]
  )

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow="HRC dashboard · mobile websocket"
        title="Sessions"
        emphasis="live."
        meta={[
          { label: 'Sessions', value: dashboard.rows.length },
          { label: 'Events', value: dashboard.events.length },
          { label: 'Filter', value: dashboard.familyFilter },
        ]}
      />

      <StatusStrip
        summary={dashboard.summary}
        controls={
          <SessionControls
            paused={dashboard.paused}
            familyFilter={dashboard.familyFilter}
            connectionState={dashboard.connectionState}
            onPause={dashboard.pause}
            onGoLive={dashboard.goLive}
            onFamilyFilterChange={dashboard.setFamilyFilter}
          />
        }
      />

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        <SessionQueue
          rows={dashboard.rows}
          selectedRowId={dashboard.selectedRowId}
          onSelectRow={dashboard.selectRow}
        />
        <div className="flex min-h-[720px] flex-col xl:flex-row">
          <EventList
            events={dashboard.events}
            selectedEventId={dashboard.selectedEventId}
            onSelectEvent={dashboard.selectEvent}
          />
          <EventInspector event={selectedEvent} />
        </div>
      </div>
    </div>
  )
}

