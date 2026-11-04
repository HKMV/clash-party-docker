/**
 * Web UI 的登录态。
 *
 * 服务会监听 0.0.0.0，因此默认强制密码：
 * - `CLASH_PARTY_WEBUI_PASSWORD` 显式指定密码；
 * - 未指定时自动生成并持久化到数据目录，启动日志里打印一次；
 * - `CLASH_PARTY_WEBUI_AUTH=off` 关闭鉴权（只建议在受信任的内网使用）。
 *
 * 会话令牌是无状态签名串，密钥持久化在数据目录，容器重启后登录态仍然有效。
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

export const SESSION_COOKIE = 'clash_party_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface AuthConfig {
  enabled: boolean
  password: string
  /** 密码是否由程序自动生成（需要在日志里提示用户） */
  generated: boolean
}

let cachedSecret: string | null = null

function readOrCreate(file: string, create: () => string): string {
  mkdirSync(path.dirname(file), { recursive: true })
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing) return existing
  }
  const value = create()
  writeFileSync(file, `${value}\n`, { encoding: 'utf-8', mode: 0o600 })
  return value
}

function secret(dataDir: string): string {
  if (cachedSecret) return cachedSecret
  cachedSecret = readOrCreate(path.join(dataDir, 'webui-secret'), () =>
    randomBytes(32).toString('hex')
  )
  return cachedSecret
}

function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)]
  return out
}

export function resolveAuthConfig(dataDir: string): AuthConfig {
  const mode = (process.env.CLASH_PARTY_WEBUI_AUTH ?? '').trim().toLowerCase()
  if (['off', 'none', 'false', '0', 'disable', 'disabled'].includes(mode)) {
    return { enabled: false, password: '', generated: false }
  }

  const fromEnv = (process.env.CLASH_PARTY_WEBUI_PASSWORD ?? '').trim()
  if (fromEnv) {
    return { enabled: true, password: fromEnv, generated: false }
  }

  const file = path.join(dataDir, 'webui-password')
  const existed = existsSync(file) && Boolean(readFileSync(file, 'utf-8').trim())
  const password = readOrCreate(file, generatePassword)
  return { enabled: true, password, generated: !existed }
}

function digest(value: string): Buffer {
  return createHmac('sha256', 'clash-party-password').update(value).digest()
}

export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(digest(input), digest(expected))
}

export function createSessionToken(dataDir: string): string {
  const expires = Date.now() + SESSION_TTL_MS
  const payload = String(expires)
  const signature = createHmac('sha256', secret(dataDir)).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(dataDir: string, token: string | undefined): boolean {
  if (!token) return false
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return false

  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expires = Number(payload)
  if (!Number.isFinite(expires) || expires < Date.now()) return false

  const expected = createHmac('sha256', secret(dataDir)).update(payload).digest('base64url')
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) result[key] = decodeURIComponent(value)
  }
  return result
}

export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
