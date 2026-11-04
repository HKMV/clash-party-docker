import { builtinModules } from 'module'
import { basename, resolve } from 'path'
import type { Plugin, UserConfig } from 'vite'

export const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

/**
 * 可选原生依赖：保留成运行时 require，未安装时由调用方自己的 try/catch 处理。
 * （`proxy-agent` 只在需要 Kerberos 认证时才会加载它。）
 */
const optionalNativeModules = ['kerberos', 'bufferutil', 'utf-8-validate']

/** 服务端构建共用的模块替换（桌面专属模块 → 纯 Node 实现）。 */
export function desktopModulePlugin(): Plugin {
  return {
    name: 'clash-party-desktop-modules',
    enforce: 'pre',
    resolveId(source) {
      // Chromium 网络栈 → axios（订阅下载 / IP 信息 / 延迟测试）
      if (/(^|\/)chromeRequest$/.test(source)) {
        return resolve('src/server/shims/chromeRequest.ts')
      }
      return null
    }
  }
}

/**
 * 主进程代码里的 `?asset` 导入（窗口图标、Sub-Store 图标）由 electron-vite 处理；
 * 服务端模式没有窗口与托盘图标，这里返回空路径占位。
 */
export function assetQueryPlugin(): Plugin {
  return {
    name: 'clash-party-asset-query',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.includes('?asset')) return null
      const resolved = await this.resolve(source.replace('?asset', ''), importer, {
        skipSelf: true
      })
      return resolved ? `${resolved.id}?asset` : null
    },
    load(id) {
      if (!id.includes('?asset')) return null
      return 'export default ""'
    }
  }
}

/**
 * `?nodeWorker` 由 electron-vite 提供：导入一个返回 Worker 实例的工厂函数。
 * 服务端构建把 worker 单独打成一个 chunk（out/server/workers/<name>.cjs），
 * 这里生成的工厂在运行时按 __dirname 定位它。
 */
export function nodeWorkerPlugin(): Plugin {
  return {
    name: 'clash-party-node-worker',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('?nodeWorker')) return null
      return this.resolve(source.slice(0, -'?nodeWorker'.length), importer, {
        skipSelf: true
      }).then((resolved) => (resolved ? `${resolved.id}?nodeWorker` : null))
    },
    load(id) {
      if (!id.endsWith('?nodeWorker')) return null
      const name = basename(id.slice(0, -'?nodeWorker'.length)).replace(/\.ts$/, '')
      return [
        "import { Worker } from 'worker_threads'",
        "import { join } from 'path'",
        `const workerPath = join(__dirname, 'workers', '${name}.cjs')`,
        'export default function createWorker(options) {',
        '  return new Worker(workerPath, options)',
        '}'
      ].join('\n')
    }
  }
}

export function serverBuildConfig(
  entry: string,
  outDir: string,
  entryFileNames: string
): UserConfig {
  return {
    define: {
      __LEGACY_BUILD__: 'false'
    },
    resolve: {
      alias: [
        { find: /^electron$/, replacement: resolve('src/server/electron-shim.ts') },
        { find: /^sysproxy-rs$/, replacement: resolve('src/server/shims/sysproxy-rs.ts') }
      ]
    },
    plugins: [assetQueryPlugin(), nodeWorkerPlugin(), desktopModulePlugin()],
    ssr: {
      target: 'node',
      // 全部依赖打进产物，运行镜像只需要 Node 运行时
      noExternal: true
    },
    build: {
      ssr: resolve(entry),
      outDir: resolve(outDir),
      target: 'node20',
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        external: [...nodeBuiltins, ...optionalNativeModules],
        output: {
          format: 'cjs',
          entryFileNames,
          inlineDynamicImports: true
        }
      }
    }
  }
}
