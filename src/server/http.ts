/* eslint-disable no-console */
/**
 * Web 服务层：把桌面版 "IPC + 窗口" 的通信方式换成 HTTP + WebSocket。
 *
 *   POST /api/invoke   { channel, args }  → 与 ipcRenderer.invoke 等价
 *   POST /api/send     { channel, args }  → 与 ipcRenderer.send 等价
 *   GET  /ws                              → 与 ipcRenderer.on 等价（服务端推送）
 *   GET  /                                → 前端产物（未登录时是登录页）
 *
 * 鉴权、登录页、静态资源与 SPA 入口都在这里，业务逻辑全部复用 `src/main/**`。
 */
import { existsSync, readFileSync } from 'fs'
import http from 'http'
import path from 'path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { addClient, clientCount, closeAllClients, removeClient } from './bridge'
import {
  clearSessionCookie,
  createSessionToken,
  parseCookies,
  passwordMatches,
  resolveAuthConfig,
  SESSION_COOKIE,
  sessionCookie,
  verifySessionToken,
  type AuthConfig
} from './auth'
import { appRoot, invokeIpc, sendIpc, userDataDir } from './electron-shim'

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self' http://127.0.0.1:*",
  "worker-src 'self' blob:"
].join('; ')

const LOGIN_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  'img-src * data:',
  "form-action 'self'"
].join('; ')

function webDir(): string {
  const fromEnv = process.env.CLASH_PARTY_WEB_DIR
  return fromEnv && fromEnv.trim() ? path.resolve(fromEnv.trim()) : path.join(appRoot, 'web')
}

function webShimCandidates(): string[] {
  return [path.join(webDir(), 'web-shim.js'), path.join(appRoot, 'out', 'web', 'web-shim.js')]
}

function findWebShim(): string | null {
  for (const candidate of webShimCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 把 Electron 版 index.html 改造成可以直接在浏览器里跑的版本：
 * 1. 放宽 CSP（需要同源 WebSocket 与 127.0.0.1 的 Sub-Store 内嵌页）；
 * 2. 在入口模块之前插入 web-shim.js，先装好 window.electron 的浏览器实现。
 */
export function transformIndexHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />`
  let output = html

  const cspPattern = /<meta\s+http-equiv=["']Content-Security-Policy["'][\s\S]*?\/?>/i
  if (cspPattern.test(output)) {
    output = output.replace(cspPattern, meta)
  } else {
    output = output.replace(/<\/head>/i, `    ${meta}\n  </head>`)
  }

  return output.replace(/<\/head>/i, `    <script src="./web-shim.js"></script>\n  </head>`)
}

function loginPage(message = ''): string {
  const hint = message
    ? `<p class="error">${message.replace(/[<>&]/g, (char) => `&#${char.charCodeAt(0)};`)}</p>`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clash Party · 登录</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
          'Microsoft YaHei', sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, #1e2a44 0%, #0b0f16 55%, #070a0f 100%);
        color: #e6edf7;
      }
      form {
        width: min(92vw, 360px);
        padding: 32px 28px;
        border-radius: 18px;
        background: rgba(19, 26, 38, 0.86);
        border: 1px solid rgba(120, 160, 220, 0.16);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(12px);
      }
      h1 { margin: 0 0 6px; font-size: 19px; letter-spacing: 0.2px; }
      p.sub { margin: 0 0 22px; font-size: 12.5px; color: #8fa1bd; }
      label { display: block; font-size: 12px; color: #8fa1bd; margin-bottom: 8px; }
      input {
        width: 100%;
        padding: 11px 13px;
        font-size: 14px;
        color: #e6edf7;
        background: rgba(8, 12, 19, 0.9);
        border: 1px solid rgba(120, 160, 220, 0.22);
        border-radius: 10px;
        outline: none;
      }
      input:focus { border-color: #4f8cff; box-shadow: 0 0 0 3px rgba(79, 140, 255, 0.18); }
      button {
        width: 100%;
        margin-top: 18px;
        padding: 11px 13px;
        font-size: 14px;
        font-weight: 600;
        color: #fff;
        background: linear-gradient(180deg, #3f7dff, #2f63e0);
        border: 0;
        border-radius: 10px;
        cursor: pointer;
      }
      button:disabled { opacity: 0.6; cursor: default; }
      p.error { margin: 14px 0 0; font-size: 12.5px; color: #ff8f8f; }
      p.tip { margin: 18px 0 0; font-size: 11.5px; line-height: 1.6; color: #6d7f99; }
    </style>
  </head>
  <body>
    <form id="login">
      <h1>Clash Party</h1>
      <p class="sub">Web 控制台登录</p>
      <label for="password">访问密码</label>
      <input id="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit" id="submit">登录</button>
      ${hint}
      <p class="tip">密码来自环境变量 CLASH_PARTY_WEBUI_PASSWORD，或容器启动日志中的一次性密码。</p>
    </form>
    <script>
      const form = document.getElementById('login')
      const input = document.getElementById('password')
      const button = document.getElementById('submit')
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        button.disabled = true
        try {
          const res = await fetch('api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ password: input.value })
          })
          if (res.ok) {
            window.location.replace('/')
            return
          }
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || '密码错误')
        } catch (error) {
          const tip = document.createElement('p')
          tip.className = 'error'
          tip.textContent = error.message || '登录失败'
          form.querySelector('p.error')?.remove()
          form.appendChild(tip)
          button.disabled = false
        }
      })
    </script>
  </body>
</html>`
}

interface ServerContext {
  auth: AuthConfig
  dataDir: string
}

function isAuthenticated(req: Request, ctx: ServerContext): boolean {
  if (!ctx.auth.enabled) return true
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  return verifySessionToken(ctx.dataDir, token)
}

function readCookieToken(header: string | undefined): string | undefined {
  return parseCookies(header)[SESSION_COOKIE]
}

export function createHttpServer(ctx: ServerContext): http.Server {
  const app = express()
  app.disable('x-powered-by')
  app.set('etag', false)
  app.use(express.json({ limit: '128mb' }))

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthenticated(req, ctx)) {
      next()
      return
    }
    res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), clients: clientCount() })
  })

  app.get('/api/session', (req, res) => {
    res.json({
      ok: true,
      result: { authenticated: isAuthenticated(req, ctx), required: ctx.auth.enabled }
    })
  })

  app.post('/api/login', (req, res) => {
    if (!ctx.auth.enabled) {
      res.json({ ok: true, result: { authenticated: true, required: false } })
      return
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!password || !passwordMatches(password, ctx.auth.password)) {
      res.status(401).json({ ok: false, error: '密码错误' })
      return
    }
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(ctx.dataDir)))
    res.json({ ok: true, result: { authenticated: true, required: true } })
  })

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie())
    res.json({ ok: true })
  })

  app.post('/api/invoke', requireAuth, async (req, res) => {
    const channel = typeof req.body?.channel === 'string' ? req.body.channel : ''
    const args = Array.isArray(req.body?.args) ? req.body.args : []
    if (!channel) {
      res.status(400).json({ ok: false, error: 'channel is required' })
      return
    }
    try {
      const result = await invokeIpc(channel, args)
      res.json({ ok: true, result: result === undefined ? null : result })
    } catch (error) {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error)
      // 与 ipc.ts 的 wrapAsync 语义一致：错误作为数据返回，由渲染层抛出
      res.json({ ok: true, result: { invokeError: message } })
    }
  })

  app.post('/api/send', requireAuth, (req, res) => {
    const channel = typeof req.body?.channel === 'string' ? req.body.channel : ''
    const args = Array.isArray(req.body?.args) ? req.body.args : []
    if (!channel) {
      res.status(400).json({ ok: false, error: 'channel is required' })
      return
    }
    try {
      sendIpc(channel, args)
      res.json({ ok: true })
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) })
    }
  })

  app.get('/web-shim.js', (_req, res) => {
    const file = findWebShim()
    if (!file) {
      res.status(404).type('text/plain').send('web-shim.js not built')
      return
    }
    res.type('application/javascript').send(readFileSync(file))
  })

  app.use(
    express.static(webDir(), {
      index: false,
      etag: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
      }
    })
  )

  const sendIndex = (req: Request, res: Response): void => {
    if (ctx.auth.enabled && !isAuthenticated(req, ctx)) {
      res.setHeader('Content-Security-Policy', LOGIN_PAGE_CSP)
      res.setHeader('Cache-Control', 'no-store')
      res.type('text/html').send(loginPage())
      return
    }
    const indexFile = path.join(webDir(), 'index.html')
    if (!existsSync(indexFile)) {
      res
        .status(503)
        .type('text/plain')
        .send(`Web UI not found at ${indexFile}. Build the renderer first.`)
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.type('text/html').send(transformIndexHtml(readFileSync(indexFile, 'utf-8')))
  }

  app.get('/', sendIndex)
  app.get('/index.html', sendIndex)
  app.get('/login', sendIndex)

  // API 只回 JSON：畸形请求体、未捕获异常都不要回 express 的 HTML 错误页
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const error = err as { type?: string; message?: string; status?: number }
    if (res.headersSent) return
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'invalid JSON body' })
      return
    }
    console.error(`[web] 请求处理失败 ${req.method} ${req.path}:`, error?.message ?? err)
    res.status(error?.status && error.status >= 400 ? error.status : 500).json({
      ok: false,
      error: error?.message ?? String(err)
    })
  })

  const server = http.createServer(app)

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? ''
    if (!url.startsWith('/ws')) {
      socket.destroy()
      return
    }
    if (ctx.auth.enabled && !verifySessionToken(ctx.dataDir, readCookieToken(req.headers.cookie))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    addClient(ws)
    ws.on('close', () => removeClient(ws))
    ws.on('error', () => removeClient(ws))
    ws.on('message', () => {
      // 客户端只做订阅，收到的消息仅用于保活
    })
  })

  const keepAlive = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.ping()
    }
  }, 30000)
  keepAlive.unref?.()

  server.on('close', () => {
    clearInterval(keepAlive)
    closeAllClients()
  })

  return server
}

export async function startServer(): Promise<http.Server> {
  const dataDir = userDataDir
  const auth = resolveAuthConfig(dataDir)
  const port = Number(process.env.CLASH_PARTY_PORT ?? 8080)
  const host = process.env.CLASH_PARTY_HOST ?? '0.0.0.0'

  const server = createHttpServer({ auth, dataDir })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const shown = host === '0.0.0.0' ? 'localhost' : host
  console.log(`[web] Clash Party 服务已启动: http://${shown}:${port}`)
  if (!auth.enabled) {
    console.log('[web] 警告: 已通过 CLASH_PARTY_WEBUI_AUTH=off 关闭鉴权，请勿暴露在公网')
  } else if (auth.generated) {
    console.log(`[web] 未设置 CLASH_PARTY_WEBUI_PASSWORD，已生成访问密码: ${auth.password}`)
    console.log(`[web] 密码同时保存在 ${path.join(dataDir, 'webui-password')}`)
  }
  if (!findWebShim()) {
    console.log('[web] 警告: 未找到 web-shim.js，浏览器端 IPC 无法工作')
  }

  return server
}
