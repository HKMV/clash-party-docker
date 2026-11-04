/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 浏览器端 IPC 垫片。
 *
 * 桌面版里 `window.electron` 由 preload 通过 contextBridge 注入；在服务端模式下
 * 没有 preload，这里用 HTTP + WebSocket 实现同样的接口：
 *
 *   ipcRenderer.invoke(channel, ...args)  → POST /api/invoke
 *   ipcRenderer.send(channel, ...args)    → POST /api/send
 *   ipcRenderer.on(channel, listener)     → /ws 订阅
 *   api.webUtils.getPathForFile(file)     → 虚拟路径（文件内容留在浏览器，按需读取）
 *
 * 由服务端在 index.html 的入口模块之前注入，因此渲染层代码无需任何改动。
 */

type Listener = (...args: any[]) => void

interface ElectronBridge {
  electron?: { ipcRenderer?: unknown; process?: { platform?: string } }
  api?: { webUtils?: unknown }
  __clashPartyWebShimInstalled?: boolean
}

const scope = window as unknown as ElectronBridge

if (!scope.electron?.ipcRenderer && !scope.__clashPartyWebShimInstalled) {
  scope.__clashPartyWebShimInstalled = true
  install()
}

function install(): void {
  const origin = window.location.origin

  /* ------------------------------------------------------- 虚拟文件（拖拽/选择） */

  const files = new Map<string, File>()
  let fileSeq = 0

  function registerFile(file: File): string {
    const id = `${++fileSeq}`
    files.set(id, file)
    return `/webupload/${id}/${file.name}`
  }

  function lookupFile(filePath: unknown): File | undefined {
    if (typeof filePath !== 'string') return undefined
    const match = /^\/webupload\/([^/]+)\//.exec(filePath)
    return match ? files.get(match[1]) : undefined
  }

  function readFileAsText(file: File): Promise<string> {
    return file.text()
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (): void => resolve(String(reader.result ?? ''))
      reader.onerror = (): void => reject(reader.error ?? new Error('read failed'))
      reader.readAsDataURL(file)
    })
  }

  function pickFile(extensions: string[]): Promise<string[] | undefined> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = extensions.map((ext) => `.${ext.replace(/^\./, '')}`).join(',')
      input.style.position = 'fixed'
      input.style.left = '-9999px'
      let settled = false

      const finish = (value: string[] | undefined): void => {
        if (settled) return
        settled = true
        input.remove()
        resolve(value)
      }

      input.addEventListener('change', () => {
        const file = input.files?.[0]
        finish(file ? [registerFile(file)] : undefined)
      })

      // 浏览器不提供"取消选择"事件，用窗口重新获得焦点作为兜底
      window.addEventListener(
        'focus',
        () => {
          window.setTimeout(() => {
            if (!input.files?.length) finish(undefined)
          }, 800)
        },
        { once: true }
      )

      document.body.appendChild(input)
      input.click()
    })
  }

  /* --------------------------------------------------------------- HTTP 通道 */

  async function postJson(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    })
    if (res.status === 401) {
      // 会话过期：刷新后由服务端返回登录页
      window.location.reload()
      throw new Error('unauthorized')
    }
    const payload = await res.json().catch(() => ({ ok: false, error: 'invalid response' }))
    if (!payload?.ok) throw new Error(payload?.error || `request failed: ${res.status}`)
    return payload
  }

  async function invoke(channel: string, ...args: any[]): Promise<any> {
    if (channel === 'readTextFile' || channel === 'getFileStr') {
      const file = lookupFile(args[0])
      if (file) return await readFileAsText(file)
    }
    if (channel === 'readImageFileDataURL') {
      const file = lookupFile(args[0])
      if (file) return await readFileAsDataUrl(file)
    }
    if (channel === 'getFilePath') {
      const extensions = Array.isArray(args[0]) ? (args[0] as string[]) : []
      return await pickFile(extensions)
    }

    const payload = await postJson('/api/invoke', { channel, args })
    return payload.result
  }

  function send(channel: string, ...args: any[]): void {
    void postJson('/api/send', { channel, args }).catch(() => {
      // fire-and-forget，与 ipcRenderer.send 语义一致
    })
  }

  /* ---------------------------------------------------------- WebSocket 订阅 */

  const listeners = new Map<string, Set<Listener>>()
  let socket: WebSocket | null = null
  let reconnectTimer: number | undefined

  function ensureSocket(): void {
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      return
    }
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    socket = ws

    ws.onmessage = (event): void => {
      let message: { channel?: string; args?: any[] }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!message?.channel) return
      const set = listeners.get(message.channel)
      if (!set) return
      const args = message.args ?? []
      for (const listener of [...set]) {
        try {
          listener(null, ...args)
        } catch (error) {
          console.error('[web-shim] listener error', error)
        }
      }
    }

    ws.onclose = (): void => {
      socket = null
      if (listeners.size > 0) {
        reconnectTimer = window.setTimeout(ensureSocket, 1500)
      }
    }

    ws.onerror = (): void => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }

  function on(channel: string, listener: Listener): () => void {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
    ensureSocket()

    return () => {
      const current = listeners.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) listeners.delete(channel)
    }
  }

  function removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener)
  }

  function removeAllListeners(channel: string): void {
    listeners.delete(channel)
  }

  /* ------------------------------------------------------------- 安装到全局 */

  scope.electron = {
    ipcRenderer: {
      invoke,
      send,
      on,
      removeListener,
      removeAllListeners
    },
    process: {
      platform: 'linux'
    }
  }

  scope.api = {
    webUtils: {
      getPathForFile: (file: File): string => registerFile(file)
    }
  }

  // 有订阅时保持长连接，避免页面空闲后再连导致事件丢失
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureSocket)
  } else {
    ensureSocket()
  }
}
