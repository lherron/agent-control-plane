import App from '@/App'
import { appRoutes } from '@/routes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, useRoutes } from 'react-router-dom'
import '@/index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

function AppRoutes() {
  const routes = useRoutes([
    {
      element: <App />,
      children: appRoutes,
    },
  ])
  return routes
}

// biome-ignore lint/style/noNonNullAssertion: root element guaranteed by index.html
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
