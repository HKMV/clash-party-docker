# Docker 部署（服务模式）

桌面版是 Electron 应用。本仓库在 `src/server/` 里补了一层 Node 服务端外壳，把同一个渲染层
（React 页面）和同一套主进程逻辑（配置、订阅、内核管理、Sub-Store、流量统计）搬到容器里跑：

- `src/server/electron-shim.ts`：纯 Node 的 `electron` 模块替身，`ipcMain` 保留 channel → handler 注册表。
- `src/server/http.ts`：Express 服务，提供静态页面、`/api/invoke`、`/api/send`、`/ws` 与密码登录。
- `src/renderer/web-shim.ts`：浏览器端的 `window.electron`，把 IPC 调用转成 HTTP/WebSocket。

因此容器版是"同一个 Clash Party 的 Web 形态"，而不是另做的简化面板。

## 快速开始

### 方式一：docker run

```bash
docker run -d --name clash-party \
  -p 8080:8080 -p 7890:7890 \
  -e CLASH_PARTY_WEBUI_PASSWORD='换成你的密码' \
  -v "$PWD/data:/data" \
  --restart unless-stopped \
  ghcr.io/hkmv/clash-party-docker:latest
```

### 方式二：docker compose（推荐）

```bash
cp .env.example .env                        # 按需填写密码、端口、时区
mkdir -p data && sudo chown 1000:1000 data  # 容器内以 uid 1000 运行
docker compose up -d
docker compose logs -f                      # 看到 [web] Clash Party 服务已启动 即可访问
```

打开 `http://<主机>:8080`，用密码登录即可。

要点：

- `docker compose` 会自动读取同目录的 `.env`，`docker-compose.yml` 里的
  `${CLASH_PARTY_WEBUI_PASSWORD}`、`${CLASH_PARTY_TAG}`、`${CLASH_PARTY_PORT}` 都来自它。
- `.env` 里密码留空时，容器首次启动会自动生成密码，写入 `/data/webui-password`
  并打印在 `docker compose logs` 里，之后一直复用（删掉该文件即可重新生成）。
- `./data` 必须属于 uid 1000，否则容器无法写入配置（报 `EACCES`）。
- 首次启动会生成默认配置，日志出现 `[web] Clash Party 服务已启动` 与
  `[manager] Core ready` 表示 Web UI 与内核都已就绪。

## docker-compose 常用操作

| 命令                                          | 说明                                                |
| --------------------------------------------- | --------------------------------------------------- |
| `docker compose up -d`                        | 启动（首次会自动拉取镜像）                          |
| `docker compose ps`                           | 查看状态与健康检查结果                              |
| `docker compose logs -f --tail=100`           | 跟踪日志，未设密码时在这里看自动生成的密码          |
| `docker compose restart`                      | 重启容器（配置改动后通常不需要，Web UI 内即可生效） |
| `docker compose pull && docker compose up -d` | 升级到新镜像，`./data` 保持不变                     |
| `docker compose down`                         | 停止并删除容器，保留 `./data`                       |
| `docker compose down -v`                      | 连同匿名卷一起删除，**配置会丢**，谨慎使用          |
| `docker compose exec clash-party sh`          | 进容器排查（镜像基于 debian slim，有 sh/node）      |

## compose 示例

以下片段直接追加或替换到 `docker-compose.yml` 的 `clash-party` 服务里。

### 1. 固定版本，避免自动跟进 latest

```yaml
services:
  clash-party:
    image: ghcr.io/hkmv/clash-party-docker:sha-ebd0ba8 # 或 smart_core / 1.2.3
```

### 2. 只作为局域网代理（不启用 TUN）

```yaml
services:
  clash-party:
    ports:
      - '8080:8080'
      - '7890:7890'
```

把局域网设备的 HTTP/SOCKS5 代理指向 `http://<主机>:7890`。服务端模式默认已开启
「允许局域网连接」（`CLASH_PARTY_ALLOW_LAN=true`），无需再去内核设置里手动打开；
不想开放时设置 `CLASH_PARTY_ALLOW_LAN=false`。

### 3. TUN 网关（host 网络）

```yaml
services:
  clash-party:
    network_mode: host # 不要同时写 ports
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      CLASH_PARTY_WEBUI_PASSWORD: ${CLASH_PARTY_WEBUI_PASSWORD:-}
```

宿主机需要已加载 `tun` 模块（`lsmod | grep tun`）。host 网络下 Web UI 直接监听
`8080`、混合代理监听 `7890`，无需端口映射；只有在 host 网络下 TUN 才会接管
宿主机流量。

### 4. 前面挂反向代理与 HTTPS

```yaml
services:
  clash-party:
    expose:
      - '8080' # 不对外发布，交给 caddy 反代

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  caddy-data:
  caddy-config:
```

`Caddyfile`：

```caddyfile
clash.example.com {
  reverse_proxy clash-party:8080
}
```

Caddy 会自动处理 WebSocket 升级；用 Nginx 时需要手动转发 `Upgrade`/`Connection` 头，
否则流量与日志面板不会更新。反代之后建议保持登录鉴权开启，不要设置
`CLASH_PARTY_WEBUI_AUTH=off`。

### 5. 备份与还原

```bash
# 备份（容器可继续运行）
docker run --rm -v "$PWD/data:/data:ro" -v "$PWD:/backup" alpine \
  tar czf /backup/clash-party-$(date +%F).tar.gz -C /data .

# 还原到新机器
docker compose down
docker run --rm -v "$PWD/data:/data" -v "$PWD:/backup" alpine \
  tar xzf /backup/clash-party-2026-11-04.tar.gz -C /data
docker compose up -d
```

`/data` 里包含 `storage-key`（加密敏感字段的密钥）与 `webui-secret`（会话签名密钥），
换机器后保持这两个文件不变，否则已保存的订阅密码需要重新输入、已登录的浏览器会掉线。

### 6. 多实例

```yaml
services:
  clash-party-2:
    image: ghcr.io/hkmv/clash-party-docker:latest
    container_name: clash-party-2
    ports:
      - '8081:8080'
      - '7893:7890'
    volumes:
      - ./data-2:/data
    environment:
      CLASH_PARTY_WEBUI_PASSWORD: ${CLASH_PARTY_WEBUI_PASSWORD_2:-}
```

每个实例要有独立的 `container_name`、端口与数据目录；同一台机器上不要把两个实例的
`7890` 映射到同一个宿主机端口。

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

### 镜像体积

`latest` 实测（registry 里的压缩体积，也就是 `docker pull` 要下载的量）：

| 架构          | 压缩后  | 层数 |
| ------------- | ------- | ---- |
| `linux/amd64` | ≈166 MB | 12   |
| `linux/arm64` | ≈166 MB | 12   |

体积分布（amd64，压缩后）：运行时基础镜像 ≈ 60 MB、内核与规则库 `extra/` ≈ 87 MB、前端资源 `web/` ≈ 18 MB、服务端 `server/` 与 `package.json` ≈ 1.4 MB。

为了压到这个量级做的取舍：

| 做法                                                  | 效果      | 代价                                                   |
| ----------------------------------------------------- | --------- | ------------------------------------------------------ |
| 运行时基于 `node:24-alpine`                           | 约 −16 MB | 无（内核是静态链接的 Go 二进制，服务端是纯 JS 单文件） |
| `strip --strip-unneeded` 剥离三个内核的符号表与 DWARF | 约 −7 MB  | 无，只影响调试符号                                     |
| 剔除 `extra/files/BundleMRS.7z`                       | 约 −2 MB  | 无，它只能由 Windows 版随附的 `7za.exe` 解包           |

还能继续压，但都要付出产品上的代价，因此默认不做：

| 做法                       | 可再省    | 代价                                                         |
| -------------------------- | --------- | ------------------------------------------------------------ |
| 去掉 `mihomo-alpha` 内核   | 约 −19 MB | 内核设置里的 alpha 通道选项要一起隐藏，等于砍掉一个上游功能  |
| 去掉 Monaco 的 `ts.worker` | 约 −4 MB  | 覆写脚本编辑器失去 JS 自动补全与类型提示                     |
| 去掉 `NotoColorEmoji.ttf`  | 约 −4 MB  | 没有系统 emoji 字体的 Linux 客户端看不到节点名里的旗帜 emoji |

## 端口

| 端口 | 用途                    | 说明                                         |
| ---- | ----------------------- | -------------------------------------------- |
| 8080 | Web UI + API            | 必须映射，默认 `CLASH_PARTY_PORT=8080`       |
| 7890 | 混合代理（HTTP/SOCKS5） | 默认开启，`bind-address: '*'` 因此可直接映射 |
| 7891 | SOCKS5                  | 需在「内核设置」里填写端口后重启内核         |
| 7892 | HTTP                    | 同上                                         |

内核默认 `bind-address: '*'`。服务端模式下 `allow-lan` 默认开启（首次启动会自动把旧的
`allow-lan: false` 迁移为 `true`），端口映射到宿主机后即可作为局域网代理使用；需要关闭时
设置 `CLASH_PARTY_ALLOW_LAN=false`，或在 Web UI 的「内核设置」里手动关闭（之后启动不再
自动改写，除非显式设置了该环境变量）。

## 环境变量

| 变量                         | 默认值            | 说明                                                                                                    |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `CLASH_PARTY_WEBUI_PASSWORD` | 自动生成          | Web UI 登录密码。未设置时启动生成一次性密码并打印在容器日志中，同时写入 `/data/webui-password`          |
| `CLASH_PARTY_WEBUI_AUTH`     | `on`              | 设为 `off` 关闭登录校验（仅限完全可信的内网）                                                           |
| `CLASH_PARTY_PORT`           | `8080`            | Web UI 监听端口                                                                                         |
| `CLASH_PARTY_HOST`           | `0.0.0.0`         | Web UI 监听地址                                                                                         |
| `CLASH_PARTY_ALLOW_LAN`      | `true`            | 代理端口是否允许局域网访问。设为 `false`/`0`/`off` 关闭；显式设置后每次启动都会覆盖「内核设置」里的开关 |
| `CLASH_PARTY_DATA_DIR`       | `/data`           | 数据目录，建议挂载成卷                                                                                  |
| `CLASH_PARTY_WEB_DIR`        | `/app/web`        | 渲染层静态资源目录                                                                                      |
| `CLASH_PARTY_RESOURCES_DIR`  | `/app/extra`      | 内核与规则库目录                                                                                        |
| `CLASH_PARTY_APP_ROOT`       | `/app`            | 应用根目录（读取 `package.json` 版本号）                                                                |
| `CLASH_PARTY_VERSION`        | 读 `package.json` | 覆盖界面上显示的版本号                                                                                  |
| `TZ`                         | 容器默认          | 时区，例如 `Asia/Shanghai`                                                                              |

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
├── webui-secret           # 会话签名密钥（保留它，重启后登录态不失效）
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

容器里没有系统会话，桌面端专属能力要么无意义、要么会误杀服务进程，**Web 模式下已直接从界面隐藏**：

| 功能                                       | 容器内表现                                                |
| ------------------------------------------ | --------------------------------------------------------- |
| 系统代理（Sys Proxy）                      | 侧边栏卡片与 `/sysproxy` 页面已隐藏（自动跳转到网络信息） |
| 检查更新 / 应用内更新按钮                  | 已隐藏，升级方式为 `docker pull` 新镜像                   |
| 退出应用 / 轻量模式 / 硬件加速（重启进程） | 已隐藏，误触会直接终止容器服务                            |
| 开机自启、静默启动、悬浮窗、托盘           | 已隐藏                                                    |
| 全局快捷键                                 | 已隐藏，浏览器里注册了也不会触发                          |
| 页头"窗口置顶"按钮                         | 已隐藏，容器内无窗口                                      |
| 打开外部链接 / 选择文件对话框              | 退化为浏览器行为：链接在浏览器打开，文件通过上传控件读取  |

其余设置项（语言、主题、侧边栏、GitHub 代理、Sub-Store、WebDAV 备份、内核设置等）与桌面版一致。

## 已知限制

- **Sub-Store 走同源反向代理**：容器里 Sub-Store 的前端（14122+）与后端（38324+）只监听
  `127.0.0.1`，浏览器够不着，所以 Web 服务把它们挂到了 `/substore/` 与 `/substore/api/`
  下，内嵌页地址变成 `http://<主机>:8080/substore/`。鉴权与主界面一致，未登录返回 401。
  如果换成"自定义 Sub-Store 后端"，内嵌页仍用本地这份前端、只把 API 指到你填的地址。
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

### 拉取阶段报 `unexpected EOF`

镜像本身是完整的：GHCR 上 `latest` 的 12 个分层 blob 逐层下载后 SHA256 全部匹配，
`linux/amd64` 与 `linux/arm64` 都齐全。`unexpected EOF` 只说明下载被截断，按顺序排查：

```bash
docker rmi ghcr.io/hkmv/clash-party-docker:latest    # 1. 清掉可能残留的半截层后重试
docker system df                                     # 2. 解压后需要 ≈500 MB 空闲
docker info --format '{{json .RegistryConfig.Mirrors}}'  # 3. 是否配了镜像站
```

1. **镜像站缓存截断**是最常见的原因：国内 ghcr 镜像站对分层返回不全时，docker 会以
   `unexpected EOF` / `failed to register layer` 收场。去掉 mirror 直连，或换一个源重试。
2. **代理要配在 daemon 上**：`docker pull` 是 dockerd 在下载，只给 shell 设
   `HTTP_PROXY`（或 `127.0.0.1:7890`）不生效。Docker Desktop 走
   Settings → Resources → Proxies；Linux 把代理写进 dockerd 的 systemd 环境变量。
3. **指定架构重试**，排除平台不匹配导致的异常：
   `docker pull --platform linux/amd64 ghcr.io/hkmv/clash-party-docker:latest`。
4. 仍失败就用离线包兜底：在能正常拉取的机器上
   `docker save ghcr.io/hkmv/clash-party-docker:latest | gzip > clash-party.tar.gz`，
   拷到目标机后 `gunzip -c clash-party.tar.gz | docker load`。
