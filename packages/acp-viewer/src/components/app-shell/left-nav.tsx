import { cn } from '@/lib/cn'
import { Bot, Clock, FolderKanban, Workflow } from 'lucide-react'
import { NavLink } from 'react-router-dom'

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/jobs', label: 'Jobs', icon: Workflow },
  { to: '/scheduler', label: 'Scheduler', icon: Clock },
]

export function LeftNav() {
  return (
    <nav className="flex flex-col h-full bg-nav-bg text-nav-foreground">
      <div className="px-4 py-4 text-sm font-semibold tracking-wide uppercase text-nav-muted">
        ACP Viewer
      </div>
      <div className="flex flex-col gap-0.5 px-2 flex-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-selected text-selected-foreground font-medium'
                  : 'text-nav-muted hover:text-nav-foreground hover:bg-white/5'
              )
            }
          >
            <item.icon className="w-4 h-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
