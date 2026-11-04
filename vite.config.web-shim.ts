import { resolve } from 'path'
import { defineConfig } from 'vite'

/**
 * 浏览器端 IPC 垫片：独立的小产物，由服务端在 index.html 中于入口模块之前注入。
 */
export default defineConfig({
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    target: 'es2020',
    minify: 'esbuild',
    reportCompressedSize: false,
    lib: {
      entry: resolve('src/renderer/web-shim.ts'),
      formats: ['iife'],
      name: 'ClashPartyWebShim',
      fileName: () => 'web-shim.js'
    }
  }
})
