/**
 * 服务端模式下 `utils/chromeRequest` 的替身。
 *
 * 桌面版走 Chromium 网络栈（`electron.net` + `session.setProxy`）以获得系统证书与
 * HTTP/2 支持；容器里没有 Chromium，这里用 axios 实现同样的接口契约，代理选项映射为
 * axios 的 proxy 配置。调用方（订阅下载、IP 信息、延迟测试）无需改动。
 */
import axios, { type AxiosRequestConfig, type Method } from 'axios'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string | Buffer
  proxy?:
    | {
        protocol: 'http' | 'https' | 'socks5'
        host: string
        port: number
      }
    | false
  timeout?: number
  responseType?: 'text' | 'json' | 'arraybuffer'
  followRedirect?: boolean
  maxRedirects?: number
  onProgress?: (loaded: number, total: number) => void
}

export interface Response<T = unknown> {
  data: T
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
}

export async function request<T = unknown>(
  url: string,
  options: RequestOptions = {}
): Promise<Response<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    proxy,
    timeout = 30000,
    responseType = 'text',
    followRedirect = true,
    maxRedirects = 20,
    onProgress
  } = options

  const config: AxiosRequestConfig = {
    url,
    method: method as Method,
    headers,
    data: body,
    timeout,
    responseType: responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
    maxRedirects: followRedirect ? maxRedirects : 0,
    // 与 Chromium 行为对齐：非 2xx 也返回响应，由调用方判断
    validateStatus: () => true,
    // socks5 不被 axios 的 proxy 选项支持，交给 agent 处理时会被忽略
    proxy:
      proxy && proxy.protocol !== 'socks5'
        ? { protocol: proxy.protocol, host: proxy.host, port: proxy.port }
        : false,
    onDownloadProgress: onProgress
      ? (event): void => onProgress(event.loaded, event.total ?? 0)
      : undefined
  }

  const res = await axios.request<T>(config)
  const responseHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }

  let data = res.data
  if (responseType === 'text' && typeof data !== 'string') {
    data = (typeof data === 'object' ? JSON.stringify(data) : String(data ?? '')) as T
  } else if (responseType === 'json' && typeof data === 'string') {
    try {
      data = JSON.parse(data) as T
    } catch {
      // 保留原始文本，交由调用方处理
    }
  } else if (responseType === 'arraybuffer' && data instanceof ArrayBuffer) {
    data = Buffer.from(data) as unknown as T
  }

  return {
    data,
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
    url
  }
}

export const get = <T = unknown>(
  url: string,
  options?: Omit<RequestOptions, 'method' | 'body'>
): Promise<Response<T>> => request<T>(url, { ...options, method: 'GET' })

export const post = <T = unknown>(
  url: string,
  data: unknown,
  options?: Omit<RequestOptions, 'method' | 'body'>
): Promise<Response<T>> => {
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  const headers = options?.headers || {}
  if (typeof data !== 'string' && !headers['content-type']) {
    headers['content-type'] = 'application/json'
  }
  return request<T>(url, { ...options, method: 'POST', body, headers })
}

export const put = <T = unknown>(
  url: string,
  data: unknown,
  options?: Omit<RequestOptions, 'method' | 'body'>
): Promise<Response<T>> => {
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  const headers = options?.headers || {}
  if (typeof data !== 'string' && !headers['content-type']) {
    headers['content-type'] = 'application/json'
  }
  return request<T>(url, { ...options, method: 'PUT', body, headers })
}

export const del = <T = unknown>(
  url: string,
  options?: Omit<RequestOptions, 'method' | 'body'>
): Promise<Response<T>> => request<T>(url, { ...options, method: 'DELETE' })

export const patch = <T = unknown>(
  url: string,
  data: unknown,
  options?: Omit<RequestOptions, 'method' | 'body'>
): Promise<Response<T>> => {
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  const headers = options?.headers || {}
  if (typeof data !== 'string' && !headers['content-type']) {
    headers['content-type'] = 'application/json'
  }
  return request<T>(url, { ...options, method: 'PATCH', body, headers })
}
