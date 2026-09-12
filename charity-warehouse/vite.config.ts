import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// 纯前端离线工程：无后端、无代理。构建产物可直接放在离线电脑上静态打开。
export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
