<h1 align="center">Openship</h1>

<p align="center">
  Open-source, self-hostable deployment platform with built-in CI/CD.<br>
  Point it at a repo — it builds, ships, routes, and TLS-terminates your app. Drive it from a desktop app, web dashboard, or CLI.
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/38817?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-38817">
    <img src="https://trendshift.io/api/badge/repositories/38817" alt="Trendshift" width="250" height="55" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#interfaces">Interfaces</a> ·
  <a href="https://openship.io/docs">Docs</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-0b7285" alt="English" /></a>
  <a href="docs/i18n/README.ar.md"><img src="https://img.shields.io/badge/lang-العربية-555" alt="العربية" /></a>
  <a href="docs/i18n/README.zh.md"><img src="https://img.shields.io/badge/lang-简体中文-555" alt="简体中文" /></a>
  <a href="docs/i18n/README.es.md"><img src="https://img.shields.io/badge/lang-Español-555" alt="Español" /></a>
  <a href="docs/i18n/README.fr.md"><img src="https://img.shields.io/badge/lang-Français-555" alt="Français" /></a>
  <a href="docs/i18n/README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-555" alt="日本語" /></a>
  <a href="docs/i18n/README.pt.md"><img src="https://img.shields.io/badge/lang-Português-555" alt="Português" /></a>
  <a href="docs/i18n/README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="docs/i18n/README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="docs/screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Quick Start

There's one decision to make first: **how you run Openship itself** (the control plane). Everything else is the same afterwards.

| If you're… | Run Openship as | Where your apps run |
|---|---|---|
| **Solo, one machine, no ops** | **Desktop app** | A server you connect over SSH, or Openship Cloud |
| **A team — or you want push-to-deploy / to host apps on your own box** | **Self-hosted server** (`openship up`) | On that box (Compose mode) — or out to another server / Cloud (bare mode) |
| **Not interested in running anything** | **Openship Cloud** | Managed sandboxes, zero setup |

> [!TIP]
> **Solo? Use the desktop app.** It runs Openship's control plane on your own machine *only while the app is open* — nothing is left running on an always-on server, nothing is exposed publicly. You only need an always-on server install once you want **push-to-deploy (CI/CD)**, **team access**, or to **host apps on that box** — the things that need a public, always-on endpoint.

### Solo — desktop app

The control plane runs locally and drives your servers over SSH. No login, no terminal, no public surface — download, open, done:

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | [Openship-arm64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-arm64.dmg) |
| **macOS** (Intel) | [Openship-x64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-x64.dmg) |
| **Windows** | [Openship-win32-x64.zip](https://github.com/oblien/openship/releases/latest/download/Openship-win32-x64.zip) |
| **Linux** | [Openship.AppImage](https://github.com/oblien/openship/releases/latest/download/Openship.AppImage) |

Linux: `chmod +x Openship.AppImage && ./Openship.AppImage`. Already have the CLI? `openship install` fetches and launches it. Links always point at the newest release.

From the desktop app you connect a server (SSH) or Openship Cloud and deploy to it — the app itself doesn't host public apps on your laptop.

### Team / always-on — self-hosted server

Install the CLI (it bundles the API + dashboard), then run **`openship`** — an interactive wizard creates the first admin, wires your domain, and installs Openship as a boot service. Run it again anytime to manage the instance.

```bash
curl -fsSL https://get.openship.io | sh          # install  (or: npm i -g openship)
openship                                          # guided setup, then control panel
```

For CI / headless boxes, skip the wizard and drive `openship up` directly:

```bash
openship up                                       # install + start as a background service (boots + auto-restarts)
openship up --public-url https://openship.example.com   # + serve the dashboard on your domain (edge + TLS handled)
```

**`openship up` picks how it runs for you:**

- **On Linux with Docker → Compose mode** (the default). Brings up the full stack — Postgres, Redis, API, dashboard, and a containerized **OpenResty edge on :80/:443** — from published images. This is the flavor that **hosts your deployed apps on the same box**, with automatic domains + Let's Encrypt TLS. Force it with `--compose`.
- **Everywhere else → bare mode** (macOS, Windows, or Linux without Docker). A single lightweight process with an embedded database — an always-on control plane that **deploys apps out to a server (SSH) or Cloud**, like the desktop app but always on and login-required. Force it with `--bare`.

A self-hosted instance **always requires login** (the admin you create in setup). `openship open` opens the dashboard · `openship stop` stops it · `openship update` upgrades · `openship up --foreground` runs attached.

**Deploy a project:**

```bash
cd your-project
openship init            # link this directory to a project
openship deploy
```

Full server guide + complete CLI reference: **[openship.io/docs](https://openship.io/docs)**.

<details>
<summary>Self-host with raw Docker Compose (no CLI)</summary>

The self-hosted stack lives in **`docker/docker-compose.yml`** and **pulls** published images from GitHub Container Registry (`ghcr.io/oblien/*`) — no build tooling, no monorepo compile. Run it from the repo root:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env          # then edit
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

The stack is **postgres + redis + api + dashboard + edge**. The `edge` is OpenResty on **:80/:443** as a container (`network_mode: host`) — routing + Let's Encrypt, no bare host install. **Linux only** (host networking); on mac/win use `openship up` (bare). The `api` container mounts the host Docker socket so the control plane can build + run your apps as host containers — it's host-privileged through the socket, so run it only on a trusted host.

**Upgrade:** pin `OPENSHIP_VERSION` in `.env` for reproducible pulls, then `docker compose --env-file .env -f docker/docker-compose.yml pull && … up -d` (or just `openship update`). **Build from source instead:** add `-f docker/docker-compose.build.yml … up -d --build`.

> The **root** `docker-compose.yml` is a different file: it's the SaaS / from-source **control plane** (builds from source, ships the marketing site, no edge/socket). It does **not** self-host your apps — use `docker/docker-compose.yml` above or `openship up`.

</details>

---

## How It Works

Point Openship at a source — a **GitHub repo**, a **local folder**, or a **prebuilt artifact** — and it runs one pipeline end to end:

1. **Detect.** It reads your `package.json`, framework config, lockfiles, and any `docker-compose.yml` / `openship.json` to work out the stack, package manager, build/start commands, and port. Zero config files required; an `openship.json` overrides the guesses if you want control.
2. **Build.** On the target server or locally on the orchestrator, into a Docker image or a bare release. The resolved config is frozen into a snapshot, so redeploys and rollbacks re-run *exactly* what shipped.
3. **Run.** As a container (published on loopback only — never a public port) or a supervised host process.
4. **Route + secure.** The OpenResty edge writes a reverse-proxy vhost to your domain and issues a Let's Encrypt certificate (HTTP-01). Because routing and TLS happen *after* the app is up, a DNS or cert hiccup surfaces as "action required" — it never fails the deploy or takes your app down.
5. **Push-to-deploy.** A GitHub webhook re-runs the pipeline on every push to the tracked branch — rebuilding only the services a monorepo push actually touched.

Databases, domains, SSL, CDN, mail, and backups are managed from the same place. (Push-to-deploy and public domains need an always-on server or Cloud — a desktop/loopback instance has no public endpoint to receive webhooks.)

---

## Interfaces

Three ways to drive the same backend:

- **Desktop app** — full GUI, real-time logs, one-click everything. Best for solo.
- **Web dashboard** — the same UI in the browser, built for teams.
- **CLI** — scriptable and CI-friendly; also how you install and manage a self-hosted instance.

An **MCP** endpoint (for AI agents) and a **REST API** round it out for automation. Only routes that opt in are exposed as MCP tools, every call re-checks your permissions, and credential/token routes can never become tools. Full reference at [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> The docs are actively being filled out. If something's missing or unclear, [contributions](CONTRIBUTING.md) are hugely welcome.

---

## Features

| | |
|---|---|
| **Built-in CI/CD** | Push-to-deploy, preview environments, staging/prod flows, rollbacks |
| **Any stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos |
| **Full backend** | Postgres, MySQL, MongoDB, Redis, workers, WebSockets, storage |
| **Domains & SSL** | Automatic Let's Encrypt, wildcards, unlimited domains, auto-renewal |
| **CDN** | Edge caching, HTTP/3, Brotli compression, instant purge |
| **Mail server** | Built-in SMTP with DKIM/SPF/DMARC — no Mailgun or SES needed |
| **Backups** | Scheduled, databases + volumes, one-click restore, export anytime |
| **Real-time monitoring** | Live build logs, container metrics, and resource usage streamed to your screen |
| **Scaling** | Auto-scaling on cloud, multi-node ready on self-hosted |
| **Portability** | Standard Docker containers — move between providers freely |
| **Docker Compose** | Deploy existing compose files as-is |

---

## Deploy Anywhere

- **Openship Cloud** — managed, auto-scaling, zero setup
- **Any VPS** — Hetzner, DigitalOcean, Linode, OVH, and the rest
- **Dedicated servers** — bare metal, colo, homelab
- **Multi-server** — spread workloads across machines

Same interface regardless of where you deploy.

---

## Status

Production-ready core, actively developed. Self-hosting is **free** (no billing).

**Coming next:** multi-node clusters, load-balancing UI, private networking, advanced monitoring, and visual CI/CD pipelines.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Releasing

Cut a release with the version script — it syncs every package's version,
commits the bump, tags `vX.Y.Z`, and pushes:

```bash
bun scripts/release.ts 0.2.0        # explicit version
# or a bump keyword: patch | minor | major | rc   (minor from 0.1.x → 0.2.0)
```

Pushing the tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

- builds the **macOS / Windows / Linux installers** and the server tarballs (with SHA-256 sidecars),
- **publishes the `openship` CLI to npm** — via npm [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) (no token), and
- creates the **GitHub Release** with the built assets (notes come from the tag).

Official Docker images (`ghcr.io/oblien/openship-{api,dashboard,edge}`) publish from
[`.github/workflows/docker-images.yml`](.github/workflows/docker-images.yml) — on a version tag, or on demand with `bun scripts/release.ts docker`.

To flag a release as **critical** (or add recommended/info advisories) in the
in-app updater, add an entry to [`release-advisories.json`](release-advisories.json)
**before** tagging — clients pull it pinned to the release tag. High-level notes
live in [`CHANGELOG.md`](CHANGELOG.md).

---

## Security

Found a vulnerability? We welcome your report — please disclose it **privately**,
never in a public issue, PR, or discussion.

- **Report it here (preferred):** [Report a vulnerability](https://github.com/oblien/openship/security/advisories/new) — a private GitHub advisory, visible only to you and the maintainers.
- Scope, what to include, and our response/disclosure process: [SECURITY.md](SECURITY.md).

Good-faith security research is **authorized** under our
[safe-harbor policy](SECURITY.md#safe-harbor), and we're happy to credit valid
first reports.

---
## ⭐ Star History

<p align="center">
  <a href="https://star-history.com/#oblien/openship&Date">
    <picture>
      <source
        media="(prefers-color-scheme: dark)"
        srcset="https://api.star-history.com/svg?repos=oblien/openship&type=Date&theme=dark"
      />
      <source
        media="(prefers-color-scheme: light)"
        srcset="https://api.star-history.com/svg?repos=oblien/openship&type=Date"
      />
      <img
        alt="Star History Chart"
        src="https://api.star-history.com/svg?repos=oblien/openship&type=Date"
      />
    </picture>
  </a>
</p>

---
## License

Openship is **open-source** software, licensed under the [Apache License 2.0](LICENSE).

You may use, run, modify, self-host, and distribute it — including in commercial
and closed-source products — under the terms of the Apache 2.0 license. See
[LICENSE](LICENSE) for the full text.
