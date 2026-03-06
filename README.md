<div align="center">
  <h1>Openship</h1>
  <p><strong>Open-source, self-hostable deployment platform.</strong></p>
  <p>Deploy anywhere — self-host on your own server or use our managed cloud.</p>

  <br />

  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a> ·
  <a href="#self-hosting">Self-Hosting</a> ·
  <a href="#cloud">Cloud</a> ·
  <a href="#contributing">Contributing</a>
</div>

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0 (package manager + runtime)
- [Node.js](https://nodejs.org/) >= 20
- [Docker](https://www.docker.com/) (for self-hosting or local development)

### Install & Run

```bash
git clone https://github.com/oblien/openship.git
cd openship
cp .env.example .env
bun install
bun dev
```

That's it. Three services start in parallel:

| Service     | URL                   | What it is                  |
| ----------- | --------------------- | --------------------------- |
| Web         | http://localhost:3000  | Marketing site & docs       |
| Dashboard   | http://localhost:3001  | Deployment dashboard (UI)   |
| API         | http://localhost:4000  | Backend engine              |

---

## Architecture

```
openship/
├── apps/
│   ├── web/              # Next.js — Landing page, pricing, docs
│   ├── dashboard/        # Next.js — Authenticated dashboard (shared: self-host + cloud)
│   ├── api/              # Hono — Core API (auth, projects, deployments, billing)
│   └── cli/              # TypeScript — CLI tool (`openship deploy`)
│
├── packages/
│   ├── adapters/         # DockerAdapter (self-host) + OblienAdapter (cloud)
│   ├── core/             # Shared types, constants, utilities, errors
│   ├── db/               # Drizzle ORM schema + client (PGlite local / Postgres cloud)
│   └── ui/               # Shared React components (Tailwind + shadcn)
│
├── tsconfig.base.json    # Shared TypeScript config (extended by all apps/packages)
├── docker-compose.yml    # One-click self-hosting
├── turbo.json            # Turborepo build pipeline
└── package.json          # Workspace root (bun workspaces)
```

### How apps connect

```
┌─────────────────┐     ┌─────────────────┐
│   apps/web      │     │  apps/dashboard  │
│  localhost:3000  │     │  localhost:3001  │
│  (marketing)     │     │  (deploy UI)     │
└─────────────────┘     └────────┬────────┘
                                 │ fetch
                        ┌────────▼────────┐
                        │    apps/api      │
                        │  localhost:4000  │
                        │  (Hono engine)   │
                        └────────┬────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
    ┌─────────▼──────┐  ┌───────▼───────┐  ┌───────▼───────┐
    │ packages/db    │  │ packages/     │  │ packages/     │
    │ (Drizzle)      │  │ adapters      │  │ core          │
    └────────────────┘  └───────────────┘  └───────────────┘
```

### Self-hosted vs Cloud — one codebase, two modes

The `CLOUD_MODE` environment variable controls what's active:

| Feature              | Self-hosted (`false`) | Cloud (`true`)  |
| -------------------- | --------------------- | --------------- |
| Auth / Users         | ✅                     | ✅               |
| Projects & Deploys   | ✅                     | ✅               |
| Custom Domains       | ✅                     | ✅               |
| Git Webhooks         | ✅                     | ✅               |
| Adapter              | DockerAdapter          | OblienAdapter   |
| Billing / Stripe     | ❌ (not mounted)       | ✅               |
| Usage Metering       | ❌                     | ✅               |
| Teams / SSO          | ❌                     | ✅ (planned)     |

Cloud-only API routes are **not even mounted** when `CLOUD_MODE=false`. Self-hosters never see them.

### API Modules

Each module follows `routes → controller → service → schema`:

```
apps/api/src/modules/<name>/
  ├── <name>.routes.ts        # Route definitions (Hono)
  ├── <name>.controller.ts    # Request handlers
  ├── <name>.service.ts       # Business logic
  └── <name>.schema.ts        # Zod validation schemas
```

| Module        | Shared | Cloud-only | Purpose                                |
| ------------- | ------ | ---------- | -------------------------------------- |
| `auth`        | ✅      |            | Register, login, JWT, sessions         |
| `projects`    | ✅      |            | CRUD for deployment projects           |
| `deployments` | ✅      |            | Build, deploy, rollback, logs          |
| `domains`     | ✅      |            | Custom domains, DNS, SSL               |
| `webhooks`    | ✅      |            | GitHub / GitLab / Bitbucket triggers   |
| `health`      | ✅      |            | Health check for load balancers        |
| `billing`     |        | ✅          | Plans, subscriptions, Stripe, usage    |

### Adapter Pattern

```typescript
// packages/adapters/src/registry.ts
getAdapter("docker")  // → DockerAdapter  (self-hosted, runs containers locally)
getAdapter("oblien")  // → OblienAdapter  (cloud, talks to Oblien infra API)
```

Both implement the same `DeploymentAdapter` interface: `deploy()`, `getStatus()`, `getLogs()`, `cancel()`, `rollback()`, `destroy()`.

---

## Development

### Run everything

```bash
bun dev
```

### Run a single app

```bash
bun dev --filter @repo/dashboard    # Dashboard only → localhost:3001
bun dev --filter @repo/api          # API only → localhost:4000
bun dev --filter @repo/web          # Web only → localhost:3000
```

### Where to edit

| What you're building               | Edit files in              |
| ----------------------------------- | -------------------------- |
| Dashboard UI (projects, deploys)    | `apps/dashboard/src/`      |
| Landing page, marketing, pricing    | `apps/web/src/`            |
| API endpoints & business logic      | `apps/api/src/`            |
| CLI commands                        | `apps/cli/src/`            |
| Shared React components             | `packages/ui/src/`         |
| Shared types, utils, errors         | `packages/core/src/`       |
| Database schema                     | `packages/db/src/schema/`  |
| Deployment adapters                 | `packages/adapters/src/`   |

### Database

```bash
bun db:generate     # Generate Drizzle migration files from schema changes
bun db:push         # Push schema to database (dev — no migration file)
bun db:migrate      # Run pending migrations (production)
```

### Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable                 | Default                    | Description                          |
| ------------------------ | -------------------------- | ------------------------------------ |
| `CLOUD_MODE`             | `false`                    | `true` = cloud with billing enabled  |
| `DATABASE_URL`           | _(empty = PGlite)_         | Empty for PGlite (dev) or `postgres://` URL |
| `BETTER_AUTH_SECRET`     | `change-me-...`            | Auth session signing secret (32+ chars) |
| `BETTER_AUTH_URL`        | `http://localhost:4000`    | API base URL for auth callbacks      |
| `REDIS_URL`              | `redis://localhost:6379`   | Queue and cache                      |
| `STRIPE_SECRET_KEY`      | —                          | Stripe key (cloud only)              |
| `STRIPE_WEBHOOK_SECRET`  | —                          | Stripe webhook secret (cloud only)   |

---

## Self-Hosting

### Docker (recommended)

```bash
git clone https://github.com/oblien/openship.git
cd openship
cp .env.example .env
docker compose up -d
```

Services:

| Service    | Port  |
| ---------- | ----- |
| Dashboard  | 3001  |
| Web        | 3000  |
| API        | 4000  |
| PostgreSQL | 5432  |
| Redis      | 6379  |

**Requirements:** Docker Engine, 2GB RAM minimum.

---

## Cloud

The hosted version at [openship.io](https://openship.io) adds:

- Managed infrastructure via the Oblien adapter
- Subscription billing (Stripe)
- Usage metering (build minutes, bandwidth)
- Team management and SSO (planned)

### Production Domains

| App        | Domain                    |
| ---------- | ------------------------- |
| Web        | `openship.io`             |
| Dashboard  | `dashboard.openship.io`   |
| API        | `api.openship.io`         |

---

## Tech Stack

| Layer      | Technology                        |
| ---------- | --------------------------------- |
| Frontend   | Next.js 14, React 18, Tailwind    |
| API        | Hono (edge-compatible)             |
| Database   | Drizzle ORM (PGlite / PostgreSQL)  |
| Auth       | Better Auth (email + OAuth)         |
| Queue      | BullMQ + Redis                     |
| CLI        | Commander.js, TypeScript           |
| Monorepo   | Turborepo + Bun workspaces        |
| Containers | Docker                             |
| Billing    | Stripe                             |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

```bash
git checkout -b feat/my-feature
# make changes
bun format
git commit -m "feat: add my feature"
git push origin feat/my-feature
# open PR
```

---

## License

[MIT](LICENSE)
