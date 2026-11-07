/**
 * 服务端模式（容器 / serve.mjs）下代理端口是否允许局域网访问。
 *
 * - 以 CLASH_PARTY_WEB_DIR 识别服务端模式，桌面模式返回 undefined（不干预 UI 设置）
 * - 默认 true：容器部署的核心用法就是把 7890 当局域网代理
 * - CLASH_PARTY_ALLOW_LAN=false/0/off/no 关闭
 */
export function resolveServerAllowLan(): boolean | undefined {
  if (!process.env.CLASH_PARTY_WEB_DIR) return undefined
  const raw = (process.env.CLASH_PARTY_ALLOW_LAN ?? '').trim().toLowerCase()
  return raw === '' ? true : !['false', '0', 'off', 'no'].includes(raw)
}
