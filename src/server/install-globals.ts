/**
 * 必须在导入任何 `src/main/**` 模块之前执行。
 *
 * `lifecycle.ts` 的 setupPlatformSpecifics() 会在模块加载时读取
 * `process.versions.electron`，纯 Node 环境下该字段不存在，直接 split 会抛异常。
 * 这里补齐 Electron/Chromium 版本号，让共享代码走"已打包的正式版"分支。
 */
const versions = process.versions as Record<string, string | undefined>

versions.electron = '43.0.0'
versions.chrome = '0.0.0'

export {}
