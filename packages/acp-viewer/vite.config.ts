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
    port: 5174,
    allowedHosts: ['max3', 'max3.local', '.local', '.tail'],
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:18470',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
