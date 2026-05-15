import { cn } from '@/lib/cn'
import { Boxes, CalendarClock, Cpu, Menu, Workflow, X } from 'lucide-react'
import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: '/projects', label: 'Projects', icon: Boxes },
  { to: '/agents', label: 'Agents', icon: Cpu },
  { to: '/jobs', label: 'Jobs', icon: Workflow },
  { to: '/scheduler', label: 'Scheduler', icon: CalendarClock },
]

export function LeftNav() {
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [drawerOpen])

  // Close on Escape.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  return (
    <>
      <DesktopSidebar />
      <MobileTopBar onMenu={() => setDrawerOpen(true)} />
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  )
}

/* ─── Desktop sidebar (lg+) ─────────────────────────────── */

function DesktopSidebar() {
  return (
    <nav className="hidden lg:flex flex-col h-full bg-nav-bg text-nav-foreground border-r border-nav-rule">
      <div className="px-6 pt-7 pb-8">
        <Masthead />
      </div>
      <NavList />
      <Footer />
    </nav>
  )
}

/* ─── Mobile top bar (below lg) ─────────────────────────── */

function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  return (
    <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between h-14 px-5 bg-nav-bg/95 backdrop-blur-sm border-b border-nav-rule">
      <Masthead size="sm" />
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
        className="inline-flex items-center justify-center h-9 w-9 -mr-1.5 rounded-[3px] text-nav-foreground hover:text-accent transition-colors"
      >
        <Menu className="h-5 w-5" />
      </button>
    </div>
  )
}

/* ─── Mobile drawer ─────────────────────────────────────── */

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'lg:hidden fixed inset-0 z-40',
        open ? 'visible' : 'invisible pointer-events-none'
      )}
    >
      {/* Backdrop */}
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-label="Close navigation"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-black/70 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0'
        )}
      />
      {/* Panel */}
      <nav
        className={cn(
          'absolute left-0 top-0 bottom-0 w-[280px] max-w-[85vw] flex flex-col',
          'bg-nav-bg text-nav-foreground border-r border-nav-rule shadow-2xl',
          'transition-transform duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)]',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-start justify-between px-6 pt-7 pb-8">
          <Masthead />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="inline-flex items-center justify-center h-9 w-9 -mr-1.5 -mt-1 rounded-[3px] text-nav-foreground hover:text-accent transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <NavList onNavigate={onClose} />
        <Footer />
      </nav>
    </div>
  )
}

/* ─── Shared sub-pieces ─────────────────────────────────── */

function Masthead({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <div
      className={cn(
        'display text-nav-foreground leading-none',
        size === 'sm' ? 'text-[22px]' : 'text-[28px]'
      )}
    >
      ACP<span className="display-italic text-accent">.</span>
    </div>
  )
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col px-3 flex-1">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
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
                className={cn('w-4 h-4 shrink-0 transition-colors', isActive ? 'text-accent' : '')}
              />
              <span className="font-medium">{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </div>
  )
}

function Footer() {
  return (
    <div className="px-6 py-4 flex items-center gap-2 text-[11px] text-nav-muted">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      read-only
    </div>
  )
}
