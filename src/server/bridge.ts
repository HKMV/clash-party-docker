/**
 * 渲染进程事件桥。
 *
 * 桌面版通过 `mainWindow.webContents.send(channel, ...args)` 把内核状态推给
 * renderer；在服务端模式下没有真实窗口，所有 `send` 都落到这里，再广播给已连接的
 * WebSocket 客户端。没有任何客户端连接时事件直接丢弃——与"窗口关闭后事件无人接收"
 * 的行为一致，前端重新连接后会通过 invoke 重新拉取全量状态。
 */
import type { WebSocket } from 'ws'

const clients = new Set<WebSocket>()

export function addClient(client: WebSocket): void {
  clients.add(client)
}

export function removeClient(client: WebSocket): void {
  clients.delete(client)
}

export function clientCount(): number {
  return clients.size
}

export function broadcast(channel: string, ...args: unknown[]): void {
  if (clients.size === 0) return

  const payload = JSON.stringify({ channel, args })
  for (const client of clients) {
    // 1 === WebSocket.OPEN
    if (client.readyState !== 1) continue
    try {
      client.send(payload)
    } catch {
      clients.delete(client)
    }
  }
}

export function closeAllClients(): void {
  for (const client of clients) {
    try {
      client.close()
    } catch {
      // ignore
    }
  }
  clients.clear()
}
