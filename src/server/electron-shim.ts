/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function */
/**
 * 服务端模式下的 `electron` 模块替身。
 *
 * 目标不是"模拟 Electron"，而是让 `src/main/**` 里已有的业务逻辑（配置、订阅、
 * 内核管理、Sub-Store、插件、流量统计……）在纯 Node 环境下原样跑起来：
 *
 * - `app`：把 Electron 的路径/生命周期 API 映射到容器内的目录与环境变量。
 * - `ipcMain`：保留 channel → handler 注册表，由 HTTP 层按同一张表分发。
 * - `BrowserWindow`：没有真实窗口，`webContents.send()` 转成 WebSocket 广播。
 * - 托盘 / 菜单 / 对话框 / 系统代理 / 快捷键等桌面专属能力退化为空操作。
 *
 * 构建时通过 vite alias 把 `electron` 指到这里（见 vite.config.server.ts），
 * 因此 `src/main/**` 的类型检查仍然使用真实的 electron 类型定义。
 */
import { EventEmitter } from 'events'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { broadcast } from './bridge'

const APP_NAME = 'clash-party'

/** 版本号：优先环境变量，其次读取应用根目录下的 package.json（容器镜像会带上它）。 */
function readAppVersion(): string {
  const candidates = [
    process.env.CLASH_PARTY_APP_ROOT
      ? path.resolve(process.env.CLASH_PARTY_APP_ROOT, 'package.json')
      : undefined,
    path.resolve(process.cwd(), 'package.json')
  ]
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue
    try {
      const version = JSON.parse(readFileSync(file, 'utf-8')).version
      if (typeof version === 'string' && version) return version
    } catch {
      // 版本号读取失败不影响服务运行，继续尝试下一个候选路径
    }
  }
  return '0.0.0'
}

const APP_VERSION = process.env.CLASH_PARTY_VERSION ?? readAppVersion()

function envDir(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() ? path.resolve(value.trim()) : fallback
}

const homeDir = os.homedir()
const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')

/** 应用根目录：`resources/` 与前端产物都在它下面。 */
export const appRoot = envDir('CLASH_PARTY_APP_ROOT', process.cwd())
/** 数据目录（对应桌面版的 userData），容器里挂载成数据卷。 */
export const userDataDir = envDir('CLASH_PARTY_DATA_DIR', path.join(configHome, APP_NAME))

function detectLocale(): string {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  if (/^zh/i.test(raw)) return 'zh-CN'
  if (raw) return raw.split('.')[0].replace('_', '-')
  return 'en-US'
}

class AppShim extends EventEmitter {
  readonly isPackaged = true
  private ready = false
  private appName = APP_NAME
  private readonly paths = new Map<string, string>()

  readonly commandLine = {
    appendSwitch: (_switch: string, _value?: string): void => {},
    appendArgument: (_arg: string): void => {},
    hasSwitch: (): boolean => false,
    getSwitchValue: (): string => '',
    removeSwitch: (): void => {}
  }

  readonly dock = {
    hide: (): void => {},
    show: (): Promise<void> => Promise.resolve(),
    setIcon: (): void => {},
    setBadge: (): void => {},
    isVisible: (): boolean => false
  }

  constructor() {
    super()
    this.setMaxListeners(0)
    this.paths.set('home', homeDir)
    this.paths.set('appData', configHome)
    this.paths.set('userData', userDataDir)
    this.paths.set('sessionData', userDataDir)
    this.paths.set('temp', os.tmpdir())
    this.paths.set('exe', process.execPath)
    this.paths.set('logs', path.join(userDataDir, 'logs'))
    this.paths.set('crashDumps', path.join(userDataDir, 'crashes'))
    for (const dir of ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos']) {
      this.paths.set(dir, path.join(homeDir, dir))
    }
  }

  getName(): string {
    return this.appName
  }

  setName(name: string): void {
    this.appName = name
  }

  getVersion(): string {
    return APP_VERSION
  }

  getLocale(): string {
    return detectLocale()
  }

  getSystemLocale(): string {
    return detectLocale()
  }

  getAppPath(): string {
    return appRoot
  }

  getPath(name: string): string {
    const resolved = this.paths.get(name)
    if (resolved) {
      // Electron 保证 userData 等目录在使用前存在
      if (name === 'userData' || name === 'logs' || name === 'crashDumps' || name === 'temp') {
        try {
          mkdirSync(resolved, { recursive: true })
        } catch {
          // 只读挂载等场景不阻塞启动
        }
      }
      return resolved
    }
    return path.join(userDataDir, name)
  }

  setPath(name: string, value: string): void {
    this.paths.set(name, value)
  }

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        this.ready = true
        this.emit('ready')
        resolve()
      })
    })
  }

  requestSingleInstanceLock(): boolean {
    return true
  }

  hasSingleInstanceLock(): boolean {
    return true
  }

  releaseSingleInstanceLock(): void {}

  quit(): void {
    let prevented = false
    const event = {
      preventDefault: (): void => {
        prevented = true
      }
    }
    this.emit('before-quit', event)
    if (prevented) return
    this.emit('will-quit', event)
    this.emit('quit', event, 0)
    process.exit(0)
  }

  exit(code = 0): void {
    process.exit(code)
  }

  relaunch(): void {
    // 容器里由编排系统负责重启，进程内不做自我重启
  }

  focus(): void {}

  hide(): void {}

  show(): void {}

  setAppUserModelId(_id: string): void {}

  setAsDefaultProtocolClient(_protocol: string, _path?: string, _args?: string[]): boolean {
    return false
  }

  removeAsDefaultProtocolClient(_protocol: string): boolean {
    return false
  }

  isDefaultProtocolClient(_protocol: string): boolean {
    return false
  }

  getLoginItemSettings(): { openAtLogin: boolean; openAsHidden: boolean } {
    return { openAtLogin: false, openAsHidden: false }
  }

  setLoginItemSettings(_settings: unknown): void {}

  disableHardwareAcceleration(): void {}

  getGPUFeatureStatus(): Record<string, string> {
    return {}
  }

  getAppMetrics(): unknown[] {
    return []
  }

  addRecentDocument(_path: string): void {}

  clearRecentDocuments(): void {}

  setAboutPanelOptions(_options: unknown): void {}
}

export const app = new AppShim()

/* ------------------------------------------------------------------ ipcMain */

type IpcHandler = (event: unknown, ...args: any[]) => unknown

const invokeHandlers = new Map<string, IpcHandler>()

class IpcMainShim extends EventEmitter {
  handle(channel: string, listener: IpcHandler): void {
    invokeHandlers.set(channel, listener)
  }

  handleOnce(channel: string, listener: IpcHandler): void {
    invokeHandlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    invokeHandlers.delete(channel)
  }
}

export const ipcMain = new IpcMainShim()

export function hasIpcHandler(channel: string): boolean {
  return invokeHandlers.has(channel)
}

export function listIpcChannels(): string[] {
  return [...invokeHandlers.keys()]
}

/** HTTP 层入口：按 renderer 的 invoke 语义执行已注册的 handler。 */
export async function invokeIpc(channel: string, args: unknown[]): Promise<unknown> {
  const handler = invokeHandlers.get(channel)
  if (!handler) throw new Error(`No IPC handler registered for channel: ${channel}`)
  return await handler({ sender: null }, ...args)
}

/** HTTP 层入口：按 renderer 的 send 语义派发 fire-and-forget 消息。 */
export function sendIpc(channel: string, args: unknown[]): void {
  ipcMain.emit(channel, { sender: null }, ...args)
  mainWebContents?.emit('ipc-message', { sender: null }, channel, ...args)
}

/* ------------------------------------------------------- webContents / 窗口 */

let mainWebContents: WebContentsShim | null = null

class WebContentsShim extends EventEmitter {
  /** 只有主窗口会向浏览器广播事件，悬浮窗等副窗口不重复推送。 */
  readonly isMain: boolean
  private readonly owner: BrowserWindowShim

  constructor(owner: BrowserWindowShim) {
    super()
    this.setMaxListeners(0)
    this.owner = owner
    this.isMain = mainWebContents === null
    // 记录主窗口的 webContents，后续事件只向它广播
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    if (this.isMain) mainWebContents = this
  }

  get id(): number {
    return 1
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.isMain) return
    broadcast(channel, ...args)
  }

  sendToFrame(_frameId: unknown, channel: string, ...args: unknown[]): void {
    this.send(channel, ...args)
  }

  openDevTools(): void {}
  closeDevTools(): void {}
  isDevToolsOpened(): boolean {
    return false
  }
  toggleDevTools(): void {}
  inspectElement(): void {}

  insertCSS(_css: string): Promise<string> {
    return Promise.resolve('')
  }

  removeInsertedCSS(_key: string): Promise<void> {
    return Promise.resolve()
  }

  reload(): void {
    broadcast('appConfigUpdated')
  }

  reloadIgnoringCache(): void {}

  isLoading(): boolean {
    return false
  }

  isLoadingMainFrame(): boolean {
    return false
  }

  isCrashed(): boolean {
    return false
  }

  isDestroyed(): boolean {
    return this.owner.isDestroyed()
  }

  getURL(): string {
    return ''
  }

  getTitle(): string {
    return APP_NAME
  }

  setWindowOpenHandler(_handler: unknown): void {}

  setZoomFactor(_factor: number): void {}
  getZoomFactor(): number {
    return 1
  }

  executeJavaScript(_code: string): Promise<unknown> {
    return Promise.resolve(undefined)
  }

  focus(): void {}
  copy(): void {}
  paste(): void {}
  selectAll(): void {}

  get session(): unknown {
    return session.defaultSession
  }

  setBackgroundThrottling(_value: boolean): void {}
}

class BrowserWindowShim extends EventEmitter {
  static readonly instances: BrowserWindowShim[] = []

  readonly webContents: WebContentsShim
  private destroyed = false
  private visible = false
  private alwaysOnTop = false

  constructor(_options?: unknown) {
    super()
    this.setMaxListeners(0)
    this.webContents = new WebContentsShim(this)
    BrowserWindowShim.instances.push(this)
    app.emit('browser-window-created', {}, this)
  }

  static getAllWindows(): BrowserWindowShim[] {
    return BrowserWindowShim.instances.filter((window) => !window.isDestroyed())
  }

  static getFocusedWindow(): BrowserWindowShim | null {
    return null
  }

  static fromWebContents(_contents: unknown): BrowserWindowShim | null {
    return null
  }

  get id(): number {
    return BrowserWindowShim.instances.indexOf(this) + 1
  }

  // 前端资源由 HTTP 服务提供，窗口本身只是占位；视为加载完成以推进启动流程。
  loadURL(_url: string): Promise<void> {
    this.markLoaded()
    return Promise.resolve()
  }

  loadFile(_file: string): Promise<void> {
    this.markLoaded()
    return Promise.resolve()
  }

  private markLoaded(): void {
    setImmediate(() => {
      if (this.destroyed) return
      this.webContents.emit('did-finish-load')
      this.webContents.emit('ipc-message', { sender: null }, 'rendererFirstContentReady')
    })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  isMaximized(): boolean {
    return false
  }

  isMinimized(): boolean {
    return false
  }

  isFullScreen(): boolean {
    return false
  }

  isFocusable(): boolean {
    return true
  }

  isResizable(): boolean {
    return true
  }

  show(): void {
    this.visible = true
    this.emit('show')
  }

  showInactive(): void {
    this.show()
  }

  hide(): void {
    this.visible = false
    this.emit('hide')
  }

  focus(): void {}
  blur(): void {}
  center(): void {}
  maximize(): void {}
  unmaximize(): void {}
  minimize(): void {}
  restore(): void {}
  setFullScreen(_value: boolean): void {}
  setSimpleFullScreen(_value: boolean): void {}
  setBounds(_bounds: unknown): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1280, height: 800 }
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1280, height: 800 }
  }
  setSize(_width: number, _height: number): void {}
  getSize(): [number, number] {
    return [1280, 800]
  }
  setPosition(_x: number, _y: number): void {}
  getPosition(): [number, number] {
    return [0, 0]
  }
  setMinimumSize(_width: number, _height: number): void {}
  setMaximumSize(_width: number, _height: number): void {}
  setResizable(_value: boolean): void {}
  setMovable(_value: boolean): void {}
  setMinimizable(_value: boolean): void {}
  setMaximizable(_value: boolean): void {}
  setClosable(_value: boolean): void {}
  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value
  }
  isAlwaysOnTop(): boolean {
    return this.alwaysOnTop
  }
  setSkipTaskbar(_value: boolean): void {}
  setIgnoreMouseEvents(_ignore: boolean, _options?: unknown): void {}
  setOpacity(_opacity: number): void {}
  setVibrancy(_vibrancy: unknown): void {}
  setBackgroundColor(_color: string): void {}
  setTitle(_title: string): void {}
  setProgressBar(_progress: number): void {}
  setOverlayIcon(_icon: unknown, _description: string): void {}
  setTitleBarOverlay(_options: unknown): void {}
  setMenu(_menu: unknown): void {}
  removeMenu(): void {}
  setAutoHideMenuBar(_value: boolean): void {}
  focusOnWebView(): void {}
  setVisibleOnAllWorkspaces(_value: boolean): void {}
  moveTop(): void {}
  previewFile(_path: string): void {}
  setWindowButtonVisibility(_value: boolean): void {}

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.visible = false
    this.emit('closed')
    const index = BrowserWindowShim.instances.indexOf(this)
    if (index >= 0) BrowserWindowShim.instances.splice(index, 1)
  }

  close(): void {
    // 服务端模式没有"关闭窗口"的语义，忽略以避免误触退出流程
  }
}

export const BrowserWindow = BrowserWindowShim

/* ----------------------------------------------------------- 桌面专属能力 */

export const dialog = {
  showMessageBox: async (_options: unknown): Promise<{ response: number }> => ({ response: 1 }),
  showMessageBoxSync: (_options: unknown): number => 1,
  showErrorBox: (title: string, content: string): void => {
    console.error(`[dialog] ${title}: ${content}`)
  },
  showOpenDialog: async (
    _options: unknown
  ): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: (_options: unknown): string[] | undefined => undefined,
  showSaveDialog: async (_options: unknown): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: true
  }),
  showSaveDialogSync: (_options: unknown): string | undefined => undefined
}

export const shell = {
  openExternal: async (_url: string): Promise<void> => {},
  openPath: async (_path: string): Promise<string> => '',
  showItemInFolder: (_path: string): void => {},
  trashItem: async (_path: string): Promise<void> => {},
  beep: (): void => {}
}

export const clipboard = {
  writeText: (_text: string): void => {},
  readText: (): string => '',
  writeHTML: (_html: string): void => {},
  readHTML: (): string => '',
  writeImage: (_image: unknown): void => {},
  readImage: (): unknown => nativeImage.createEmpty(),
  writeBuffer: (_format: string, _buffer: Buffer): void => {},
  readBuffer: (_format: string): Buffer => Buffer.alloc(0),
  has: (_format: string): boolean => false,
  clear: (): void => {}
}

const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1280, height: 800 },
  workArea: { x: 0, y: 0, width: 1280, height: 800 },
  workAreaSize: { width: 1280, height: 800 },
  size: { width: 1280, height: 800 },
  scaleFactor: 1,
  rotation: 0,
  internal: false,
  label: 'container'
}

export const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: (): typeof primaryDisplay => primaryDisplay,
  getAllDisplays: (): (typeof primaryDisplay)[] => [primaryDisplay],
  getDisplayMatching: (_rect: unknown): typeof primaryDisplay => primaryDisplay,
  getDisplayNearestPoint: (_point: unknown): typeof primaryDisplay => primaryDisplay,
  getCursorScreenPoint: (): { x: number; y: number } => ({ x: 0, y: 0 })
})

export const nativeTheme = Object.assign(new EventEmitter(), {
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: true,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  inForcedColorsMode: false
})

export const systemPreferences = {
  getUserDefault: (_key: string, _type: unknown): unknown => null,
  isDarkMode: (): boolean => true,
  isAeroGlassEnabled: (): boolean => false,
  getMediaAccessStatus: (_type: string): string => 'granted',
  getEffectiveAppearance: (): string => 'dark',
  on: (): void => {},
  removeListener: (): void => {}
}

export const globalShortcut = {
  register: (_accelerator: string, _callback: () => void): boolean => false,
  registerAll: (_accelerators: string[], _callback: () => void): void => {},
  isRegistered: (_accelerator: string): boolean => false,
  unregister: (_accelerator: string): void => {},
  unregisterAll: (): void => {}
}

export const powerMonitor = Object.assign(new EventEmitter(), {
  getSystemIdleState: (_threshold: number): string => 'active',
  getSystemIdleTime: (): number => 0,
  isOnBatteryPower: (): boolean => false
})

export const net = {
  isOnline: (): boolean => true,
  request: (_options: unknown): never => {
    throw new Error('electron.net is not available in server mode')
  },
  fetch: async (): Promise<never> => {
    throw new Error('electron.net is not available in server mode')
  },
  resolveHost: async (): Promise<never> => {
    throw new Error('electron.net is not available in server mode')
  }
}

/**
 * 容器里没有 Keychain/DPAPI/libsecret，`safeStorage` 用数据目录里的随机密钥做
 * AES-256-GCM 加解密：插件凭据仍然加密落盘，但密钥与密文同机存放，
 * 安全性等价于 Electron 在无 keyring 的 Linux 上的 `basic_text` 后端。
 */
let storageKey: Buffer | null = null

function getStorageKey(): Buffer {
  if (storageKey) return storageKey
  const keyPath = path.join(userDataDir, 'storage-key')
  try {
    if (existsSync(keyPath)) {
      const existing = Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'hex')
      if (existing.length === 32) {
        storageKey = existing
        return storageKey
      }
    }
    const generated = randomBytes(32)
    mkdirSync(path.dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, generated.toString('hex'), { encoding: 'utf-8', mode: 0o600 })
    storageKey = generated
    return storageKey
  } catch {
    // 只读文件系统等场景退化为进程内密钥（重启后密文不可解）
    storageKey = storageKey ?? randomBytes(32)
    return storageKey
  }
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): string => 'basic_text',
  setUsePlainTextEncryption: (_usePlainText: boolean): void => {},
  encryptString: (plainText: string): Buffer => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', getStorageKey(), iv)
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decryptString: (encrypted: Buffer): string => {
    if (encrypted.length < 28) throw new Error('encrypted payload is too short')
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const payload = encrypted.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', getStorageKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
  }
}

const sessionShim = {
  setProxy: async (_config: unknown): Promise<void> => {},
  resolveProxy: async (_url: string): Promise<string> => 'DIRECT',
  clearCache: async (): Promise<void> => {},
  clearStorageData: async (): Promise<void> => {},
  cookies: {
    get: async (): Promise<unknown[]> => [],
    set: async (): Promise<void> => {},
    remove: async (): Promise<void> => {}
  },
  webRequest: {
    onBeforeSendHeaders: (): void => {},
    onHeadersReceived: (): void => {},
    onBeforeRequest: (): void => {}
  }
}

export const session = {
  defaultSession: sessionShim,
  fromPartition: (_partition: string, _options?: unknown): typeof sessionShim => sessionShim,
  fromPath: (_path: string): typeof sessionShim => sessionShim
}

function imageStub(): Record<string, unknown> {
  const image: Record<string, unknown> = {
    isEmpty: (): boolean => true,
    isTemplateImage: (): boolean => false,
    getSize: (): { width: number; height: number } => ({ width: 0, height: 0 }),
    toPNG: (): Buffer => Buffer.alloc(0),
    toJPEG: (_quality: number): Buffer => Buffer.alloc(0),
    toBitmap: (): Buffer => Buffer.alloc(0),
    toDataURL: (): string => '',
    getAspectRatio: (): number => 1,
    resize: (): Record<string, unknown> => image,
    crop: (): Record<string, unknown> => image,
    setTemplateImage: (): void => {}
  }
  return image
}

export const nativeImage = {
  createEmpty: (): Record<string, unknown> => imageStub(),
  createFromPath: (_path: string): Record<string, unknown> => imageStub(),
  createFromBuffer: (_buffer: Buffer, _options?: unknown): Record<string, unknown> => imageStub(),
  createFromDataURL: (_dataUrl: string): Record<string, unknown> => imageStub(),
  createFromNamedImage: (_name: string): Record<string, unknown> => imageStub()
}

export class Tray extends EventEmitter {
  constructor(_image: unknown) {
    super()
    this.setMaxListeners(0)
  }

  setImage(_image: unknown): void {}
  setPressedImage(_image: unknown): void {}
  setToolTip(_tooltip: string): void {}
  setTitle(_title: string): void {}
  setContextMenu(_menu: unknown): void {}
  popUpContextMenu(_menu?: unknown): void {}
  setIgnoreDoubleClickEvents(_ignore: boolean): void {}
  setIgnoreDoubleClickEventsEnabled(_ignore: boolean): void {}
  ignoreDoubleClickEvents(_ignore: boolean): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  getTitle(): string {
    return ''
  }
  isDestroyed(): boolean {
    return false
  }
  focus(): void {}
  destroy(): void {}
}

export class MenuItem {
  constructor(_options?: unknown) {}
}

export class Menu {
  static buildFromTemplate(_template: unknown[]): Menu {
    return new Menu()
  }

  static setApplicationMenu(_menu: Menu | null): void {}

  static getApplicationMenu(): Menu | null {
    return null
  }

  static sendActionToFirstResponder(_action: string): void {}

  popup(_options?: unknown): void {}
  closePopup(_window?: unknown): void {}
  append(_item: unknown): void {}
  getMenuItemById(_id: string): null {
    return null
  }
}

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return false
  }

  constructor(_options?: unknown) {
    super()
    this.setMaxListeners(0)
  }

  show(): void {}
  close(): void {}
}

const electronModule = {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  clipboard,
  screen,
  nativeTheme,
  systemPreferences,
  globalShortcut,
  powerMonitor,
  net,
  session,
  nativeImage,
  safeStorage,
  Tray,
  Menu,
  MenuItem,
  Notification
}

export default electronModule
