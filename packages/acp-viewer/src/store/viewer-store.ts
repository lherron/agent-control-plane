import { create } from 'zustand'

interface ViewerState {
  selectedProjectId: string | undefined
  selectedAgentId: string | undefined
  selectedJobId: string | undefined
  setSelectedProjectId: (id: string | undefined) => void
  setSelectedAgentId: (id: string | undefined) => void
  setSelectedJobId: (id: string | undefined) => void
}

export const useViewerStore = create<ViewerState>((set) => ({
  selectedProjectId: undefined,
  selectedAgentId: undefined,
  selectedJobId: undefined,
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  setSelectedJobId: (id) => set({ selectedJobId: id }),
}))
