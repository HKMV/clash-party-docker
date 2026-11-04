<h3 align="center">
  <img height='48px' src='./images/icon-white.png#gh-dark-mode-only'>
  <img height='48px' src='./images/icon-black.png#gh-light-mode-only'>
</h3>

<h3 align="center">Another <a href="https://github.com/MetaCubeX/mihomo">Mihomo</a> GUI</h3>

<p align="center">
  <a href="https://github.com/mihomo-party-org/clash-party/releases">
    <img src="https://img.shields.io/github/release/mihomo-party-org/clash-party/all.svg">
  </a>
  <a href="https://t.me/mihomo_party_group">
    <img src="https://img.shields.io/badge/Telegram-Group-blue?logo=telegram">
  </a>
</p>
<div align='center'>
<img width='90%' src="./images/preview.jpg">
</div>

### 本项目认证稳定机场推荐：“[狗狗加速](https://party.dginv.click/#/register?code=ARdo0mXx)”

##### [狗狗加速 —— 技术流机场 Doggygo VPN](https://party.dginv.click/#/register?code=ARdo0mXx)

- 高性能海外机场，稳定首选，海外团队，无跑路风险
- Clash Party专属8折优惠码：party，仅有500份
- Party专属链接注册送 3 天，每天 1G 流量 [免费试用](https://party.dginv.click/#/register?code=ARdo0mXx)
- 优惠套餐每月仅需 15.8 元，160G 流量，年付 8 折
- 全球首家支持Hysteria1/2 协议，集群负载均衡设计，高速专线，基于最新UDP quic技术，极低延迟，无视晚高峰，4K 秒开，配合Clash Party食用更省心！
- 解锁流媒体及 ChatGPT
- 官网：[https://狗狗加速.com](https://party.dginv.click/#/register?code=ARdo0mXx)

### 特性

- [x] 一键 Smart Core 规则覆写，基于 AI 模型自动选择最优节点 详细介绍请看 [这里](https://clashparty.org/docs/guide/smart-core)
- [x] 开箱即用，无需服务模式的 Tun
- [x] 多种配色主题可选，UI 焕然一新
- [x] 支持大部分 Mihomo(Clash Meta) 常用配置修改
- [x] 内置 Smart内核 与 Mihomo(Clash Meta) 内核
- [x] 通过 WebDAV 一键备份和恢复配置
- [x] 强大的覆写功能，任意修订配置文件
- [x] 深度集成 Sub-Store，轻松管理订阅

### 安装/使用指南见 [官方文档](https://clashparty.org)

### Docker 部署（服务模式）

除桌面版外，本仓库还可以把同一个界面跑成容器里的 Web 服务，镜像由 GitHub Actions 自动构建并推送到 GHCR：

```bash
docker run -d --name clash-party \
  -p 8080:8080 -p 7890:7890 \
  -e CLASH_PARTY_WEBUI_PASSWORD='换成你的密码' \
  -v "$PWD/data:/data" \
  --restart unless-stopped \
  ghcr.io/hkmv/clash-party-docker:latest
```

打开 `http://<主机>:8080` 登录即可。多架构镜像（`linux/amd64` / `linux/arm64`）、环境变量、
数据卷、TUN 与桌面功能的差异、已知限制，详见 [docs/docker.md](docs/docker.md)。

仓库内也提供了 [docker-compose.yml](docker-compose.yml) 与 [Dockerfile](Dockerfile)，
可自行 `docker build` 或 `docker compose up -d`。
