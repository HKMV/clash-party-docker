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
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from 'express'
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
  // /substore 走同源代理；127.0.0.1 与 https: 留给"自定义 Sub-Store 地址"
  "frame-src 'self' http://127.0.0.1:* https:",
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

/** Sub-Store 前端里写死的根绝对资源路径，需要一并转发到它自己的目录 */
const SUB_STORE_ASSET_MOUNTS = ['/chunks', '/css', '/fonts', '/images']

/**
 * Sub-Store 前端是 history 路由的 SPA，路由表里只有 `/`、`/subs` 这类根路径。
 * 挂到 `/substore/` 下之后 `location.pathname` 变成 `/substore/...`，路由一条都匹配不上，
 * 页面只会显示"地址未找到"。这里在入口脚本之前把 pathname 还原成根路径让路由正常启动，
 * 同时给 pushState/replaceState 补前缀，保证地址栏（以及刷新）仍然落在 `/substore` 下。
 */
const SUB_STORE_ROUTER_SHIM = `<script>
(function () {
  var P = '/substore'
  var push = history.pushState
  var replace = history.replaceState
  function withPrefix(url) {
    if (typeof url !== 'string') return url
    var origin = location.origin
    var rest = url.indexOf(origin) === 0 ? url.slice(origin.length) : url.charAt(0) === '/' ? url : null
    if (rest === null) return url
    if (rest === P || rest.indexOf(P + '/') === 0) return url
    return origin + P + rest
  }
  history.pushState = function (state, title, url) { return push.call(this, state, title, withPrefix(url)) }
  history.replaceState = function (state, title, url) { return replace.call(this, state, title, withPrefix(url)) }
  var path = location.pathname
  var OFFICIAL = 'https://sub.store'
  // 前端的"后端"默认值写死成官方 https://sub.store，容器里既出不去也不是本机数据，
  // 页面会直接显示"数据加载失败 / 请配置自定义后端"。这里把默认后端换成同源 /substore，
  // 用户自己加过的后端保持不动。
  try {
    var KEY = 'hostAPI'
    var conf = { current: '', apis: [] }
    var raw = localStorage.getItem(KEY)
    if (raw) conf = JSON.parse(raw) || conf
    if (!conf.apis || !conf.apis.length) conf.apis = []
    var local = null
    var current = null
    var k
    for (k = 0; k < conf.apis.length; k++) {
      var item = conf.apis[k]
      if (!item) continue
      if (item.url === P) local = item
      if (item.name === conf.current) current = item
    }
    if (!local) {
      var name = '本机'
      for (var n = 2; n < 100; n++) {
        var taken = false
        for (k = 0; k < conf.apis.length; k++) if (conf.apis[k] && conf.apis[k].name === name) taken = true
        if (!taken) break
        name = '本机 ' + n
      }
      local = { name: name, url: P }
      conf.apis.push(local)
    }
    if (!current || !current.url || String(current.url).indexOf(OFFICIAL) === 0) conf.current = local.name
    localStorage.setItem(KEY, JSON.stringify(conf))
  } catch (e) {}
  // 兜底：已经算出来的官方后端地址也一起改回本机同源接口
  function mapApi(u) {
    if (typeof u !== 'string') return u
    var rest = u.indexOf(OFFICIAL) === 0 ? u.slice(OFFICIAL.length) : null
    if (rest === null || rest.charAt(0) !== '/') return u
    return P + rest
  }
  var xhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = mapApi(url)
    return xhrOpen.apply(this, arguments)
  }
  var rawFetch = window.fetch
  if (rawFetch) {
    window.fetch = function (input, init) {
      return rawFetch.call(this, typeof input === 'string' ? mapApi(input) : input, init)
    }
  }
  if (path.indexOf(P) === 0) {
    // 用原生 replaceState 还原，避免被上面的补前缀逻辑又改回去
    replace.call(history, history.state, '', (path.slice(P.length) || '/') + location.search + location.hash)
  }
})()
</script>`

/**
 * Sub-Store 的两处布局在内嵌场景下不合适，这里统一修正：
 * 1. 主容器限宽 900px 居中，宽屏下两侧大片留白
 * 2. 侧边栏在窄屏（<1024px）退化成悬浮图标条，展开时盖住内容 —— 内嵌页通常
 *    只有 900~1100px 宽，正好落在这个区间，看起来像坏掉
 * 桌面宽度下改成"常驻左栏 + 内容右移"，窄屏（手机）保持原样不动。
 */
const SUB_STORE_LAYOUT_SHIM = `<style>
  .nav-bar-wrapper,
  .page-body,
  .app-layout-wrapper,
  .add-sub-popup {
    max-width: 100% !important;
  }
  @media (min-width: 720px) {
    .side-bar-wrapper {
      left: 0 !important;
      right: auto !important;
      top: 56px !important;
      bottom: 0 !important;
      transform: none !important;
      width: 200px !important;
      height: auto !important;
      border-radius: 0 !important;
      padding: 16px 12px !important;
      background: var(--background-color, #f7f7f8) !important;
      box-shadow: none !important;
      border-right: 1px solid rgba(127, 127, 127, 0.16) !important;
    }
    .side-bar-wrapper .sidebar-content {
      width: 100% !important;
    }
    .side-bar-wrapper .menu-item {
      justify-content: flex-start !important;
      padding: 10px 12px !important;
      border-radius: 8px !important;
    }
    .side-bar-wrapper .menu-item .label {
      display: inline !important;
    }
    #app .page-body {
      padding-left: 200px !important;
      box-sizing: border-box !important;
    }
    /* 订阅列表顶部的筛选条是 position:fixed + left:50% 居中的，留出左栏后会被压住一半，
       这里把它的居中轴挪到内容区，并禁止超出内容宽度。注意只在订阅列表容器内生效：
       "我的"等页面里同名的 radio-wrapper 是页面内的表单项，不能一起位移。 */
    .subs-list-wrapper .radio-wrapper {
      left: calc(50% + 100px) !important;
      max-width: min(900px, calc(100% - 240px)) !important;
    }
  }
</style>`

/** 前端 index.html 的资源都写成 `/xxx`，挂到 /substore 下必须补前缀 */
function rewriteSubStoreHtml(html: string, baseHref?: string): string {
  return (
    html
      .replace(/(href|src)="\/(?!\/)/g, '$1="/substore/')
      // PWA 的 service worker 作用域会覆盖整个站点，嵌在 iframe 里没有必要，去掉
      .replace(/<script[^>]*registerSW\.js[^>]*><\/script>/i, '')
      .replace(
        /<head(\s[^>]*)?>/i,
        (head) =>
          `${head}\n    ${baseHref ? `<base href="${baseHref}">\n    ` : ''}${SUB_STORE_ROUTER_SHIM}\n    ${SUB_STORE_LAYOUT_SHIM}`
      )
  )
}

/**
 * 主进程模块在 HTTP 服务启动之后才加载，Sub-Store 的端口也是运行时才分配的
 * （前端 14122 起、后端 38324 起，取第一个空闲端口），所以每次请求时再读。
 *
 * 服务是开机后异步拉起的，容器里 Web UI 可能先就绪。分享出去的 /preview、/download
 * 链接在服务还没起来时会拿到 503，所以端口缺失时这里按需启动一次再读。是否启用
 * Sub-Store 由配置决定，没启用时仍然是 503，提示语不变。
 */
async function subStorePorts(): Promise<{ frontend?: number; backend?: number }> {
  const mod = await import('../main/resolve/server')
  if (mod.subStoreFrontendPort && mod.subStorePort) {
    return { frontend: mod.subStoreFrontendPort, backend: mod.subStorePort }
  }
  try {
    const init = await import('../main/utils/init')
    await init.startSubStoreServices()
  } catch {
    // 启动失败按未启动处理，交给调用方返回 503
  }
  return { frontend: mod.subStoreFrontendPort, backend: mod.subStorePort }
}

function forwardSubStore(
  req: Request,
  res: Response,
  port: number,
  targetPath: string,
  rewriteHtml: boolean,
  baseHref?: string
): void {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` }
  delete headers.origin
  // 无请求体的请求可以安全重发：后端子进程刚拉起来时端口已经分配、监听还没就绪，
  // 直接 502 会让内嵌页弹一堆"数据加载失败"。带请求体的（POST/PUT）只试一次。
  const canRetry = req.method === 'GET' || req.method === 'HEAD'
  const maxAttempts = canRetry ? 20 : 1
  const attempt = (round: number): void => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        path: targetPath,
        method: req.method,
        // 浏览器的同源请求也会带 Origin，Sub-Store 后端会按 CORS 白名单校验并
        // 直接 403（CORS origin not allowed）。请求经同源代理转发后来源已经是
        // 本机服务，这里剥离 Origin，让后端按非浏览器请求放行，白名单不用放宽。
        headers
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers }
        const isHtml = String(headers['content-type'] ?? '').includes('text/html')
        if (!rewriteHtml || !isHtml) {
          res.writeHead(upstreamRes.statusCode ?? 502, headers)
          upstreamRes.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
        upstreamRes.on('end', () => {
          const body = rewriteSubStoreHtml(Buffer.concat(chunks).toString('utf-8'), baseHref)
          delete headers['content-length']
          delete headers['transfer-encoding']
          res.writeHead(upstreamRes.statusCode ?? 200, headers)
          res.end(body)
        })
      }
    )
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (round < maxAttempts) {
        setTimeout(() => attempt(round + 1), 300)
        return
      }
      res.status(502).json({ ok: false, error: `Sub-Store 未就绪：${error.message}` })
    })
    if (canRetry) {
      upstream.end()
      return
    }
    req.pipe(upstream)
  }
  attempt(1)
}

/**
 * Sub-Store 同源代理。
 *
 * 桌面版里 Sub-Store 的前后端都只监听 `127.0.0.1`，渲染进程与它们同机，内嵌页直接写
 * `http://127.0.0.1:<port>` 就能用。容器里渲染层跑在用户自己的浏览器上，那个
 * `127.0.0.1` 指向的是用户机器，页面只会一直显示"无法访问此网站"。
 *
 * 这里把两者挂到同源路径下，浏览器够得着的地址就变成 Web UI 自己：
 *   /substore/       → 前端（index.html 的根绝对路径改写成 /substore/ 前缀）
 *   /substore/api/*  → 后端（Sub-Store 自己就是 /api/*，前缀去掉即可）
 * 前端产物引用的 /chunks /css /fonts /images 是根绝对路径，另外单独转发。
 *
 * 必须注册在 express.json 之前：JSON 请求体被解析器吃掉后就没法再转发给上游。
 */
function registerSubStoreProxy(app: Express, requireAuth: RequestHandler): void {
  const frontendHandler = async (req: Request, res: Response): Promise<void> => {
    const { frontend, backend } = await subStorePorts()
    const target = req.url || '/'
    // 后端除了 /api/*，还直接挂了订阅下载/分享路由 /download/:name、/download/collection/:name。
    // 这些以前被当成前端页面转发，分享出去或填进客户端的链接拿到的是一张 HTML，必须交给后端。
    const isBackend =
      target === '/api' ||
      target.startsWith('/api/') ||
      target === '/download' ||
      target.startsWith('/download')
    if (isBackend) {
      if (!backend) {
        res.status(503).json({ ok: false, error: 'Sub-Store 后端未启动' })
        return
      }
      forwardSubStore(req, res, backend, target, false)
      return
    }
    if (!frontend) {
      res.status(503).json({ ok: false, error: 'Sub-Store 前端未启动' })
      return
    }
    // SPA 内部的接口调用是相对路径 `api/...`。访问 `/substore`（无尾部斜杠）时浏览器会
    // 把它解析成 `/api/...` 打到本服务自己的接口上，页面报"数据加载失败"。固定一个
    // <base href="/substore/"> 后，任何深度的页面都能正确解析到 /substore/api/*。
    forwardSubStore(req, res, frontend, target, true, '/substore/')
  }

  app.use('/substore', requireAuth, frontendHandler)

  // Sub-Store 生成的分享/预览链接是 `<origin>/preview?url=...&name=...`（前端本地路由，
  // 不带 /substore 前缀）。这里补一条同源路由交给前端 SPA，否则直接落到本服务 404，
  // 页面显示 "Cannot GET /preview"。SPA 里的接口调用是相对路径 `api/...`，需要用
  // <base href="/substore/"> 让它仍然解析到 /substore/api/*。
  app.get('/preview', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const { frontend } = await subStorePorts()
    if (!frontend) {
      res.status(503).type('text/plain').send('Sub-Store 前端未启动')
      return
    }
    forwardSubStore(req, res, frontend, '/', true, '/substore/')
  })

  for (const mount of SUB_STORE_ASSET_MOUNTS) {
    app.use(mount, requireAuth, async (req: Request, res: Response): Promise<void> => {
      const { frontend } = await subStorePorts()
      if (!frontend) {
        res.status(404).end()
        return
      }
      forwardSubStore(req, res, frontend, `${mount}${req.url || ''}`, false)
    })
  }
}

export function createHttpServer(ctx: ServerContext): http.Server {
  const app = express()
  app.disable('x-powered-by')
  app.set('etag', false)

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthenticated(req, ctx)) {
      next()
      return
    }
    res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  // 静态资源与 /api 之前：子应用请求体要原样转发，不能被 json 解析器消费
  registerSubStoreProxy(app, requireAuth)
  app.use(express.json({ limit: '128mb' }))

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

  registerSubStoreProxy(app, requireAuth)

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
