import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'acp-ops-projection': resolve(__dirname, '../acp-ops-projection/src/index.ts'),
      'acp-ops-reducer': resolve(__dirname, '../acp-ops-reducer/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:18470',
        changeOrigin: true,
      },
    },
  },
})
