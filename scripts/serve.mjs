/**
 * 本地以服务端模式启动（等价于容器里的 `node out/server/index.cjs`）。
 *
 * 默认把数据写到 ./.data，资源目录指向 ./extra，前端产物指向 out/renderer，
 * 都可用同名环境变量覆盖。
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

const root = process.cwd()

const defaults = {
  CLASH_PARTY_APP_ROOT: root,
  CLASH_PARTY_RESOURCES_DIR: path.join(root, 'extra'),
  CLASH_PARTY_WEB_DIR: path.join(root, 'out', 'renderer'),
  CLASH_PARTY_DATA_DIR: path.join(root, '.data'),
  CLASH_PARTY_PORT: '8080'
}

const env = { ...defaults, ...process.env }
const entry = path.join(root, 'out', 'server', 'index.cjs')

if (!existsSync(entry)) {
  console.error(`未找到 ${entry}，请先运行 pnpm run build:server`)
  process.exit(1)
}

const child = spawn(process.execPath, [entry], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
