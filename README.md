<div align="center">
  <h1>🚀 Openship</h1>
  <p><strong>The open-source, self-hostable deployment platform.</strong></p>
  <p>Deploy anywhere — from your own server to our managed cloud.</p>

  <br />

  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#self-hosting">Self-Hosting</a> ·
  <a href="#cloud">Cloud</a> ·
  <a href="#contributing">Contributing</a>
</div>

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 9
- [Docker](https://www.docker.com/) (for self-hosting or local development)

### Development

```bash
# Clone the repo
git clone https://github.com/openship/openship.git
cd openship

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env

# Generate Prisma client
pnpm db:generate

# Push schema to local SQLite
pnpm db:push

# Start all apps in dev mode
pnpm dev
```

This will start:

| App         | URL                     |
| ----------- | ----------------------- |
| Web         | http://localhost:3000    |
| Dashboard   | http://localhost:3001    |
| API         | http://localhost:4000    |

### Self-Hosting with Docker

```bash
cp .env.example .env
docker compose up -d
```

That's it. Openship will be running at `http://localhost:3001`.

---

## Architecture

```
openship/
├── apps/
│   ├── web/          # Next.js — Marketing site, landing page, docs, pricing
│   ├── dashboard/    # Next.js — Authenticated deployment dashboard (Vercel-style)
│   ├── api/          # Hono — Core API engine (auth, deployments, billing, webhooks)
│   └── cli/          # TypeScript CLI — `openship deploy` from your terminal
│
├── packages/
│   ├── adapters/     # Deployment adapters (DockerAdapter, OblienAdapter)
│   ├── db/           # Prisma schema + client (SQLite local, Postgres cloud)
│   ├── core/         # Shared types, constants, utilities, error classes
│   └── ui/           # Shared React component library (Tailwind + shadcn style)
│
├── tooling/
│   └── tsconfig/     # Shared TypeScript configurations
│
├── docker-compose.yml
├── turbo.json
└── pnpm-workspace.yaml
```

### API Modules

The API is organized into clean, independent modules:

| Module         | Path                          | Purpose                                  |
| -------------- | ----------------------------- | ---------------------------------------- |
| **Auth**       | `modules/auth/`               | Registration, login, JWT, sessions       |
| **Projects**   | `modules/projects/`           | CRUD for deployment projects             |
| **Deployments**| `modules/deployments/`        | Build, deploy, rollback, logs            |
| **Domains**    | `modules/domains/`            | Custom domains, DNS verification, SSL    |
| **Billing**    | `modules/billing/`            | Plans, subscriptions, usage (cloud only) |
| **Webhooks**   | `modules/webhooks/`           | GitHub/GitLab/Bitbucket push triggers    |
| **Health**     | `modules/health/`             | Health check endpoint for load balancers |

### Adapter Pattern

The **adapter pattern** is what makes Openship platform-agnostic:

- **`DockerAdapter`** — Self-hosted. Builds and runs containers on the host machine.
- **`OblienAdapter`** — Cloud. Communicates with the Oblien infrastructure API.

The `CLOUD_MODE` environment variable controls which adapter is active. For self-hosted installs, billing is completely disabled.

---

## Self-Hosting

Openship is designed to be self-hosted with a single `docker compose up`. The Docker adapter handles all builds and deployments locally on your machine.

**Requirements:** Docker Engine, 2GB RAM minimum.

---

## Cloud

The hosted version at [openship.cloud](https://openship.cloud) adds:

- Managed infrastructure via the Oblien adapter
- Subscription billing (Stripe)
- Usage metering (build minutes, bandwidth)
- Team management and SSO

---

## Tech Stack

| Layer      | Technology                        |
| ---------- | --------------------------------- |
| Frontend   | Next.js 14, React 18, Tailwind    |
| API        | Hono (edge-compatible)             |
| Database   | Prisma (SQLite / PostgreSQL)       |
| Queue      | BullMQ + Redis                     |
| CLI        | Commander.js, TypeScript           |
| Monorepo   | Turborepo + pnpm workspaces       |
| Containers | Docker                             |
| Billing    | Stripe                             |

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## License

[MIT](LICENSE) — Free to use, self-host, and modify. Cloud/SaaS usage requires the AGPL license terms.
