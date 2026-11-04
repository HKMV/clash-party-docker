/**
 * 服务端模式下 `sysproxy-rs` 的替身。
 *
 * 容器里没有可写的"系统代理"（既没有桌面会话，也不应该去改宿主机设置），
 * 同时避免在镜像里携带平台相关的原生 `.node` 二进制。桌面版仍然使用真实实现。
 */
export async function triggerAutoProxy(_enable: boolean, _pacUrl: string): Promise<void> {
  // no-op
}

export async function triggerManualProxy(
  _enable: boolean,
  _host: string,
  _port: number,
  _bypass: string
): Promise<void> {
  // no-op
}
