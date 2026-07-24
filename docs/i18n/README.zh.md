<h1 align="center">Openship</h1>

<p align="center">
  开源、可自托管的部署平台，内置 CI/CD。<br>
  推送代码、发布容器、管理基础设施 —— 通过桌面应用、Web 控制台或 CLI。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="../../README.md"><img src="https://img.shields.io/badge/lang-English-555" alt="English" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/lang-العربية-555" alt="العربية" /></a>
  <a href="README.zh.md"><img src="https://img.shields.io/badge/lang-简体中文-0b7285" alt="简体中文" /></a>
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-555" alt="Español" /></a>
  <a href="README.fr.md"><img src="https://img.shields.io/badge/lang-Français-555" alt="Français" /></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-555" alt="日本語" /></a>
  <a href="README.pt.md"><img src="https://img.shields.io/badge/lang-Português-555" alt="Português" /></a>
  <a href="README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## 快速开始

```bash
npm i -g openship
openship init
```

就这么简单。或者，如果你更喜欢 Docker：

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

或从 [openship.io](https://openship.io) 下载桌面应用。

---

## 功能简介

把它指向一个代码仓库。Openship 会检测你的技术栈、构建它、配置好一切并发布 —— 没有配置文件、没有流水线、没有 YAML。

数据库、域名、SSL、CDN、邮件、备份 —— 全部在一处管理。

支持 **Openship Cloud**（托管）或你自己拥有的**任意 Linux 服务器**。独立开发者发布副业项目、团队运行生产环境，用的是同一个工具。

---

## 特性

| | |
|---|---|
| **内置 CI/CD** | 推送即部署、预览环境、staging/生产 流程、回滚 |
| **任意技术栈** | Node、Python、Go、Rust、PHP、Ruby、Java、.NET、Docker、Monorepo |
| **完整后端** | Postgres、MySQL、MongoDB、Redis、Worker、WebSocket、存储 |
| **域名与 SSL** | 自动 Let's Encrypt、通配符、无限域名、自动续期 |
| **CDN** | 边缘缓存、HTTP/3、Brotli 压缩、即时清除 |
| **邮件服务器** | 内置 SMTP，支持 DKIM/SPF/DMARC —— 无需 Mailgun 或 SES |
| **备份** | 定时、数据库 + 卷、一键恢复、随时导出 |
| **实时监控** | 实时构建日志、容器指标、资源使用情况实时推送到你的屏幕 |
| **伸缩** | 云端自动伸缩、自托管支持多节点 |
| **可移植性** | 标准 Docker 容器 —— 在服务商之间自由迁移 |
| **Docker Compose** | 原样部署现有的 compose 文件 |

---

## 部署到任何地方

- **Openship Cloud** —— 托管、自动伸缩、零配置
- **任意 VPS** —— Hetzner、DigitalOcean、Linode、OVH 等
- **独立服务器** —— 裸机、托管机房、家庭实验室
- **多服务器** —— 将负载分散到多台机器

无论部署在哪里，界面都一样。

---

## 三种界面

- **桌面应用** —— 完整 GUI、实时日志、一键操作。
- **Web 控制台** —— 浏览器中的同一套界面，为团队打造。
- **CLI** —— 可脚本化、对 CI 友好。

**REST API** 和 **MCP**（AI 智能体协议）为自动化和工具集成收尾。完整的命令与 API 参考见 [openship.io/docs](https://openship.io/docs)。

> [!NOTE]
> 文档仍在完善中 —— 我们正在积极补充。如果有缺失或不清楚的地方，非常欢迎[贡献](../../CONTRIBUTING.md)，这能帮助我们更快完善。

---

## 状态

核心已可用于生产，持续积极开发中。

**即将推出：** 多节点集群、负载均衡 UI、私有网络、高级监控，以及可视化 CI/CD 流水线。

---

## 贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

---

## 许可证

Openship 是**开源**软件，依据 [Apache License 2.0](../../LICENSE) 授权。

你可以使用、运行、修改、自托管和分发它 —— 包括用于商业和闭源产品 —— 只要遵守 Apache 2.0 许可证的条款。完整文本见 [LICENSE](../../LICENSE)。
