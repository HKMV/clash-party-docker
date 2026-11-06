/**
 * 是否运行在 Web 服务模式（浏览器里访问容器/服务器）。
 *
 * 打包的桌面客户端不会注入 web-shim，浏览器版 index.html 会在入口模块之前
 * 先加载 web-shim.js 并打上 `__clashPartyWebShimInstalled` 标记。
 * 桌面端专属的能力（托盘、开机自启、窗口置顶、应用内更新等）在这里判断后隐藏，
 * 避免用户点到在容器里无意义甚至有害的操作。
 */
export const isWebMode = Boolean(
  (window as unknown as { __clashPartyWebShimInstalled?: boolean }).__clashPartyWebShimInstalled
)
