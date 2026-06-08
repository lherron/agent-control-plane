import { Button } from '@/components/ui/button'
import type { FamilyFilter, StreamConnectionState } from '@/features/sessions/types'
import { cn } from '@/lib/cn'
import { Pause, Radio, WifiOff } from 'lucide-react'
import { EVENT_FAMILIES, connectionTone } from './event-family'

export function SessionControls({
  paused,
  familyFilter,
  connectionState,
  onPause,
  onGoLive,
  onFamilyFilterChange,
}: {
  paused: boolean
  familyFilter: FamilyFilter
  connectionState: StreamConnectionState
  onPause: () => void
  onGoLive: () => void
  onFamilyFilterChange: (family: FamilyFilter) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="inline-flex h-9 items-center rounded-[4px] border border-border bg-background/40 p-0.5">
        <Button
          type="button"
          size="sm"
          variant={paused ? 'ghost' : 'secondary'}
          onClick={onGoLive}
          className={cn(
            'h-7 rounded-[3px] px-2.5 text-[12px]',
            !paused && 'bg-accent text-accent-foreground hover:bg-accent-warm'
          )}
        >
          <Radio className="h-3.5 w-3.5" />
          Live
        </Button>
        <Button
          type="button"
          size="sm"
          variant={paused ? 'secondary' : 'ghost'}
          onClick={onPause}
          className={cn(
            'h-7 rounded-[3px] px-2.5 text-[12px]',
            paused && 'bg-warn text-background hover:bg-warn'
          )}
        >
          <Pause className="h-3.5 w-3.5" />
          Pause
        </Button>
      </div>

      <label className="inline-flex h-9 items-center gap-2 rounded-[4px] border border-border bg-background/40 px-2.5 text-[12px] text-muted">
        <span className="kicker text-[9px] text-quiet">family</span>
        <select
          value={familyFilter}
          aria-label="Event family filter"
          onChange={(event) => onFamilyFilterChange(event.currentTarget.value as FamilyFilter)}
          className="bg-transparent text-ink focus:outline-none"
        >
          <option value="all">all</option>
          {EVENT_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      </label>

      <output
        data-state={connectionState}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-[4px] px-3 text-[11px] font-semibold uppercase tracking-[0.08em]',
          connectionTone(connectionState)
        )}
      >
        {connectionState === 'disconnected' && <WifiOff className="h-3.5 w-3.5" />}
        {connectionState}
      </output>
    </div>
  )
}
