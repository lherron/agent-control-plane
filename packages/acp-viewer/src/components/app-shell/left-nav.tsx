import { cn } from '@/lib/cn'
import { Boxes, CalendarClock, Cpu, Workflow } from 'lucide-react'
import { NavLink } from 'react-router-dom'

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: '/projects', label: 'Projects', icon: Boxes },
  { to: '/agents', label: 'Agents', icon: Cpu },
  { to: '/jobs', label: 'Jobs', icon: Workflow },
  { to: '/scheduler', label: 'Scheduler', icon: CalendarClock },
]

export function LeftNav() {
  return (
    <nav className="flex flex-col h-full bg-nav-bg text-nav-foreground border-r border-nav-rule">
      {/* Masthead */}
      <div className="px-6 pt-7 pb-8">
        <div className="display text-[28px] text-nav-foreground leading-none">
          ACP<span className="display-italic text-accent">.</span>
        </div>
      </div>

      {/* Nav */}
      <div className="flex flex-col px-3 flex-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 px-3 py-2 rounded-[3px] text-[13px] transition-colors',
                isActive ? 'text-nav-foreground' : 'text-nav-muted hover:text-nav-foreground'
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'absolute left-0 top-1.5 bottom-1.5 w-[2px] transition-all duration-200',
                    isActive ? 'bg-accent' : 'bg-transparent'
                  )}
                />
                <item.icon
                  className={cn(
                    'w-4 h-4 shrink-0 transition-colors',
                    isActive ? 'text-accent' : ''
                  )}
                />
                <span className="font-medium">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>

      {/* Footer — minimal */}
      <div className="px-6 py-4 flex items-center gap-2 text-[11px] text-nav-muted">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </span>
        read-only
      </div>
    </nav>
  )
}
