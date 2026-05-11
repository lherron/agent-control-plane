import { LeftNav } from '@/components/app-shell/left-nav'
import { Outlet } from 'react-router-dom'

export default function App() {
  return (
    <div className="grid grid-cols-[232px_minmax(0,1fr)] min-h-screen bg-background">
      <LeftNav />
      <main className="flex-1 overflow-auto min-w-0">
        <Outlet />
      </main>
    </div>
  )
}
