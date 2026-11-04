import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
import { serverBuildConfig } from './vite.server.shared'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }

export default defineConfig({
  ...serverBuildConfig('src/server/index.ts', 'out/server', 'index.cjs'),
  define: {
    __LEGACY_BUILD__: 'false',
    // 版本号在构建期内联，运行时不需要 package.json
    'process.env.CLASH_PARTY_VERSION': JSON.stringify(pkg.version)
  },
  build: {
    ...serverBuildConfig('src/server/index.ts', 'out/server', 'index.cjs').build,
    // 主产物与 worker 产物写同一个目录，清理由 build:server 脚本统一负责
    emptyOutDir: false
  }
})
