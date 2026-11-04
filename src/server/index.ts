/**
 * Clash Party 服务端模式入口。
 *
 * 与 Electron 入口（src/main/index.ts）的唯一区别是运行环境：
 * 这里先用 install-globals + electron-shim 把 `electron` 模块替换成纯 Node 实现，
 * 然后原样加载主进程逻辑——配置、订阅、内核管理、Sub-Store、插件、流量统计全部复用。
 * 渲染层由 HTTP 服务提供，通过 /api + /ws 与主进程通信。
 */
import './install-globals'

async function bootstrap(): Promise<void> {
  const { startServer } = await import('./http')
  const server = await startServer()

  const shutdown = (): void => {
    server.close()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  // 主进程逻辑自带完整的启动编排（内核、监控、Sub-Store、托盘退化等）
  await import('../main/index')
}

bootstrap().catch((error) => {
  console.error('[server] 启动失败', error)
  process.exit(1)
})
