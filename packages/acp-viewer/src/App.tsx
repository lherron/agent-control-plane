import { LeftNav } from '@/components/app-shell/left-nav'
import { Outlet } from 'react-router-dom'

export default function App() {
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <LeftNav />
      <main className="min-w-0 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
