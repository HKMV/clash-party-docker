import { defineConfig } from 'vite'
import { serverBuildConfig } from './vite.server.shared'

/**
 * 流量统计 worker（`?nodeWorker`）单独打包成一个 chunk，由主产物按 __dirname 引用。
 */
export default defineConfig({
  ...serverBuildConfig(
    'src/main/traffic/database-worker.ts',
    'out/server/workers',
    'database-worker.cjs'
  ),
  build: {
    ...serverBuildConfig(
      'src/main/traffic/database-worker.ts',
      'out/server/workers',
      'database-worker.cjs'
    ).build,
    // 主产物先构建，这里不能清空 out/server
    emptyOutDir: false
  }
})
