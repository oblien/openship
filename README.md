<h1 align="center">Openship</h1>

<p align="center">
  Open-source deployment platform with built-in CI/CD.<br>
  Push code, ship containers, manage infrastructure — from a desktop app, web dashboard, or CLI.
</p>

<p align="center">
  <img src="docs/screenshots/screen.png" alt="Openship" width="800" />
</p>

---

## Quick Start

```bash
npm i -g openship
openship init
```

That's it. Or if you prefer Docker:

```bash
git clone https://github.com/openship/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

Or download the desktop app from [openship.io](https://openship.io).

---

## What It Does

Point it at a repo. Openship detects your stack, builds it, configures everything, and ships it — zero config files, zero pipelines, zero YAML.

Databases, domains, SSL, CDN, mail, backups — all managed from one place.

Works with **Openship Cloud** (managed) or **any Linux server** you own. Solo devs shipping side projects and teams running production — same tool.

---

## Features

| | |
|---|---|
| **Built-in CI/CD** | Push-to-deploy, preview environments, staging/prod flows, rollbacks |
| **Any stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos |
| **Full backend** | Postgres, MySQL, MongoDB, Redis, workers, WebSockets, storage |
| **Domains & SSL** | Auto Let’s Encrypt, wildcards, unlimited domains, auto-renewal |
| **CDN** | Edge caching, HTTP/3, Brotli compression, instant purge |
| **Mail server** | Built-in SMTP with DKIM/SPF/DMARC — no Mailgun/SES needed |
| **Backups** | Scheduled · databases + volumes · one-click restore · export anytime |
| **Real-time monitoring** | Live build logs, container metrics, resource usage — streamed to your screen |
| **Scaling** | Auto-scaling on cloud · multi-node ready on self-hosted |
| **Portability** | Standard Docker containers — move between providers freely |
| **Docker Compose** | Deploy existing compose files as-is |

---

## Deploy Anywhere

- **Openship Cloud** — managed, auto-scaling, zero setup
- **Any VPS** — Hetzner, DigitalOcean, Linode, OVH, whatever
- **Dedicated servers** — bare metal, colo, homelab
- **Multi-server** — spread workloads across machines

Same interface regardless of where you deploy.

---

## Three Interfaces

**Desktop app** — full GUI, real-time logs, one-click everything.

**Web dashboard** — same UI, browser-based, for teams.

**CLI** — scriptable, CI-friendly.

```bash
openship deploy
openship logs --follow
openship rollback
openship domains
```

**REST API** and **MCP** (AI agent protocol) for automation and tooling integration.

---

## How Is This Different From Coolify / CapRover / Dokku?

Those tools run their entire control plane on your server — dashboards, build systems, CI runners, databases, and your apps, all competing for the same resources.

Openship builds locally and ships production containers. Your server runs your apps and nothing else.

```
You                           Your server
┌─────────────────────┐       ┌─────────────────────┐
│  Desktop / Web UI   │  SSH  │                     │
│  Builds             │──────→│  Your apps only      │
│  CLI / API          │       │                     │
└─────────────────────┘       └─────────────────────┘
```

You can also run builds on the server if you prefer — it’s a config flag, not a religion.

---

## Status

Production-ready core. Actively developed.

**Coming next:** multi-node clusters, load balancing UI, private networking, advanced monitoring, visual CI/CD pipelines.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[AGPL-3.0](LICENSE)
