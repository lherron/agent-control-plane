import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'acp-ops-projection': path.resolve(__dirname, '../acp-ops-projection/src/index.ts'),
      'acp-ops-reducer': path.resolve(__dirname, '../acp-ops-reducer/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 18471,
    strictPort: true,
    allowedHosts: [
      'max3',
      'max3.lan',
      'max3.local',
      'max3.tail53cc3b.ts.net',
      '.lan',
      '.local',
      '.tail',
      '.ts.net',
    ],
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:18470',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
