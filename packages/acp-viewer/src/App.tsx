import { LeftNav } from '@/components/app-shell/left-nav'
import { ProvenanceStrip } from '@/components/provenance-strip'
import { Outlet } from 'react-router-dom'

export default function App() {
  return (
    <div className="grid grid-cols-[232px_minmax(0,1fr)] min-h-screen">
      <LeftNav />
      <div className="flex flex-col bg-workbench">
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
        <ProvenanceStrip items={[]} />
      </div>
    </div>
  )
}
