# Docker 部署（服务模式）

桌面版是 Electron 应用。本仓库在 `src/server/` 里补了一层 Node 服务端外壳，把同一个渲染层
（React 页面）和同一套主进程逻辑（配置、订阅、内核管理、Sub-Store、流量统计）搬到容器里跑：

- `src/server/electron-shim.ts`：纯 Node 的 `electron` 模块替身，`ipcMain` 保留 channel → handler 注册表。
- `src/server/http.ts`：Express 服务，提供静态页面、`/api/invoke`、`/api/send`、`/ws` 与密码登录。
- `src/renderer/web-shim.ts`：浏览器端的 `window.electron`，把 IPC 调用转成 HTTP/WebSocket。

因此容器版是"同一个 Clash Party 的 Web 形态"，而不是另做的简化面板。

## 快速开始

```bash
docker run -d --name clash-party \
  -p 8080:8080 -p 7890:7890 \
  -e CLASH_PARTY_WEBUI_PASSWORD='换成你的密码' \
  -v "$PWD/data:/data" \
  --restart unless-stopped \
  ghcr.io/hkmv/clash-party-docker:latest
```

或者用仓库里的 `docker-compose.yml`：

```bash
mkdir -p data && sudo chown 1000:1000 data   # 容器内以 uid 1000 运行
docker compose up -d
```

打开 `http://<主机>:8080`，用密码登录即可。

## 镜像

GHCR 上的包首次推送后默认是私有的。要么在仓库的 Packages 页面把
`clash-party-docker` 的可见性改成 public，要么先登录再拉取：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <你的 GitHub 用户名> --password-stdin
```

| 标签                  | 说明                     |
| --------------------- | ------------------------ |
| `latest`              | 默认分支最新构建         |
| `smart_core` / `main` | 对应分支最新构建         |
| `sha-<短哈希>`        | 单次提交构建             |
| `1.2.3` / `1.2`       | 推送 `v1.2.3` 标签时生成 |

多架构：`linux/amd64`、`linux/arm64`（`TARGETARCH` 由 buildx 注入，构建时下载对应架构的 mihomo 内核）。

## 端口

| 端口 | 用途                    | 说明                                         |
| ---- | ----------------------- | -------------------------------------------- |
| 8080 | Web UI + API            | 必须映射，默认 `CLASH_PARTY_PORT=8080`       |
| 7890 | 混合代理（HTTP/SOCKS5） | 默认开启，`bind-address: '*'` 因此可直接映射 |
| 7891 | SOCKS5                  | 需在「内核设置」里填写端口后重启内核         |
| 7892 | HTTP                    | 同上                                         |

内核默认 `bind-address: '*'`，因此端口映射到宿主机后即可作为局域网代理使用；
是否需要允许局域网访问由 mihomo 自身的 `allow-lan` 决定（在 Web UI 的「内核设置」里调整）。

## 环境变量

| 变量                         | 默认值            | 说明                                                                                           |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `CLASH_PARTY_WEBUI_PASSWORD` | 自动生成          | Web UI 登录密码。未设置时启动生成一次性密码并打印在容器日志中，同时写入 `/data/webui-password` |
| `CLASH_PARTY_WEBUI_AUTH`     | `on`              | 设为 `off` 关闭登录校验（仅限完全可信的内网）                                                  |
| `CLASH_PARTY_PORT`           | `8080`            | Web UI 监听端口                                                                                |
| `CLASH_PARTY_HOST`           | `0.0.0.0`         | Web UI 监听地址                                                                                |
| `CLASH_PARTY_DATA_DIR`       | `/data`           | 数据目录，建议挂载成卷                                                                         |
| `CLASH_PARTY_WEB_DIR`        | `/app/web`        | 渲染层静态资源目录                                                                             |
| `CLASH_PARTY_RESOURCES_DIR`  | `/app/extra`      | 内核与规则库目录                                                                               |
| `CLASH_PARTY_APP_ROOT`       | `/app`            | 应用根目录（读取 `package.json` 版本号）                                                       |
| `CLASH_PARTY_VERSION`        | 读 `package.json` | 覆盖界面上显示的版本号                                                                         |
| `TZ`                         | 容器默认          | 时区，例如 `Asia/Shanghai`                                                                     |

## 数据卷

`/data` 保存全部可变状态，备份它等于备份整个配置：

```
/data
├── config.yaml            # 应用配置
├── mihomo.yaml            # 内核设置
├── profile.yaml           # 订阅列表
├── profiles/              # 订阅文件
├── override/              # 覆写脚本与配置
├── rules/                 # 自定义规则
├── work/                  # 内核工作目录（运行时生成）
├── logs/                  # 内核与应用日志
├── substore/              # Sub-Store 数据
├── traffic-usage.db       # 流量统计（node:sqlite）
├── webui-password         # 自动生成的登录密码
└── storage-key            # safeStorage 加密密钥（加密敏感字段用）
```

升级镜像时保留 `/data` 即可平滑迁移。

## TUN 模式

容器内的 TUN 需要宿主机内核加载 `tun` 模块，并给容器 `NET_ADMIN` 与 `/dev/net/tun`：

```yaml
cap_add:
  - NET_ADMIN
devices:
  - /dev/net/tun:/dev/net/tun
```

即使如此，TUN 只影响**容器自己的网络命名空间**，除非容器使用 `network_mode: host`，
否则不会接管宿主机或局域网设备的流量。要让容器作为网关，请使用 `network_mode: host`
或让其它容器把网关指向它。

## 与桌面版的差异

容器里没有系统会话，下列能力退化为空操作（界面上仍然存在，但不会生效）：

| 功能                                   | 容器内表现                                               |
| -------------------------------------- | -------------------------------------------------------- |
| 系统代理（Sys Proxy）                  | 不生效，请把客户端指向 7890 端口                         |
| 托盘、悬浮窗、全局快捷键               | 不存在                                                   |
| 自动更新                               | 不生效，升级方式为拉取新镜像                             |
| 开机自启、UWP 回环豁免、TrafficMonitor | Windows 专属，容器内不可用                               |
| 打开外部链接 / 选择文件对话框          | 退化为浏览器行为：链接在浏览器打开，文件通过上传控件读取 |

## 已知限制

- **Sub-Store 内嵌页在远程访问时不可用**：该页面用 `iframe` 嵌入 `http://127.0.0.1:<端口>`，
  在远程浏览器里 `127.0.0.1` 指向用户自己的机器。Sub-Store 后端本身在容器内正常运行，
  受影响的只是这个内嵌管理页面。桌面客户端不受影响。
- **登录鉴权只保护 Web UI**：7890 代理端口本身没有额外认证；如需认证请在
  「内核设置」里配置 mihomo 的 `authentication` 字段。
- **首次启动会生成默认配置**：`/data` 为空时自动写入 `config.yaml`、`mihomo.yaml` 等默认文件，
  日志里会出现 `[web] Clash Party 服务已启动` 与 `[manager] Core ready`。

## 从源码构建

```bash
# 本地构建（需要 Docker）
docker build -t clash-party-docker .

# 只跑构建，不推送
docker buildx build --platform linux/amd64,linux/arm64 .
```

构建阶段会执行 `scripts/prepare.mjs <arch>` 下载对应架构的内核、规则库、Sub-Store 与字体，
再执行 `pnpm run build:docker`（渲染层 + 服务端 + 浏览器 shim）。

## 本地开发（不用 Docker）

```bash
pnpm install --ignore-scripts
node scripts/prepare.mjs
pnpm run build:docker
pnpm run start:server        # 等价于 CLASH_PARTY_DATA_DIR=./.data node out/server/index.cjs
```

`scripts/serve.mjs` 默认把数据写到 `./.data`，资源目录用仓库里的 `extra/`，
访问 `http://localhost:8080`，密码打印在控制台。

## 排错

```bash
docker logs -f clash-party                 # 查看启动日志与自动生成的密码
docker exec clash-party node -e \
  "fetch('http://127.0.0.1:8080/api/health').then(r=>r.text()).then(console.log)"
```

- 启动日志出现 `[web] Clash Party 服务已启动` 表示 Web UI 就绪。
- `[manager] Core ready after N attempts` 表示 mihomo 内核已被拉起。
- 若内核起不来，先确认镜像架构与宿主机一致：`docker exec clash-party uname -m`。
