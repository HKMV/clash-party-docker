# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 1. 依赖安装
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
ENV CI=1
WORKDIR /src
RUN npm install -g pnpm@11.8.0
# 只复制依赖清单，改动源码时可直接复用这一层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# package.json 里 sysproxy-rs 是 file: 依赖，安装前目录必须存在
COPY src/native/sysproxy ./src/native/sysproxy
# --ignore-scripts：容器内不需要 Electron 二进制，也不需要 electron-builder 的原生重建。
# 服务端构建时 electron / sysproxy-rs / electron.net 均由 src/server/shims 替换。
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# 2. 构建
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
# buildx 多架构构建时自动注入 TARGETARCH（amd64 / arm64），无需在 workflow 里传参
ARG TARGETARCH=amd64
# 下载目标架构的 mihomo 内核、规则库、Sub-Store 与字体资源到 extra/
RUN node scripts/prepare.mjs "$( [ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64 )"
# 三个内核都是静态链接的 Go 二进制，剥掉符号表与 DWARF 后体积明显下降，运行不受影响。
# arm64 的内核要用 aarch64 交叉 binutils 处理，amd64 用自带的 strip；失败不阻断构建，只记日志。
RUN apt-get update \
  && apt-get install -y --no-install-recommends binutils binutils-aarch64-linux-gnu \
  && rm -rf /var/lib/apt/lists/*
RUN STRIP="$( [ "$TARGETARCH" = "arm64" ] && echo aarch64-linux-gnu-strip || echo strip )"; \
  for f in extra/sidecar/mihomo extra/sidecar/mihomo-alpha extra/sidecar/mihomo-smart; do \
    before=$(stat -c%s "$f"); \
    if $STRIP --strip-unneeded "$f"; then \
      after=$(stat -c%s "$f"); \
      echo "strip $f: $((before / 1024 / 1024))MB -> $((after / 1024 / 1024))MB"; \
    else \
      echo "WARN: strip failed for $f, keeping original"; \
    fi; \
  done
# BundleMRS.7z 只能由 Windows 版随附的 7za.exe 解包，容器里是死重量
RUN rm -f extra/files/BundleMRS.7z
# 渲染层 out/renderer + 服务端单文件 out/server + 浏览器 shim out/web
RUN pnpm run build:docker

# ---------------------------------------------------------------------------
# 3. 运行时
# ---------------------------------------------------------------------------
# Alpine：三个内核都是静态链接的 Go 二进制，服务端是纯 JS 单文件，运行时不需要 glibc。
# 相比 bookworm-slim 少约 16MB（压缩后）。
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    CLASH_PARTY_APP_ROOT=/app \
    CLASH_PARTY_DATA_DIR=/data \
    CLASH_PARTY_WEB_DIR=/app/web \
    CLASH_PARTY_RESOURCES_DIR=/app/extra \
    CLASH_PARTY_HOST=0.0.0.0 \
    CLASH_PARTY_PORT=8080
WORKDIR /app

# tzdata 让 TZ 环境变量生效；ca-certificates 供内核拉取订阅与规则集
RUN apk add --no-cache tzdata ca-certificates

COPY --chown=node:node --from=build /src/out/server ./server
COPY --chown=node:node --from=build /src/out/renderer ./web
COPY --chown=node:node --from=build /src/out/web/web-shim.js ./web/web-shim.js
COPY --chown=node:node --from=build /src/extra ./extra
COPY --chown=node:node --from=build /src/package.json ./package.json

# /data 存放配置、订阅、内核工作目录与访问密码，必须可写
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]

# 8080 Web UI；7890 混合代理；7891 SOCKS5；7892 HTTP
EXPOSE 8080 7890 7891 7892

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CLASH_PARTY_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.cjs"]
