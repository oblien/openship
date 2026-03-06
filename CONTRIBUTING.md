# Contributing to Openship

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

```bash
git clone https://github.com/oblien/openship.git
cd openship
cp .env.example .env
bun install
bun dev
```

This starts all three services:

| Service     | URL                   |
| ----------- | --------------------- |
| Web         | http://localhost:3000  |
| Dashboard   | http://localhost:3001  |
| API         | http://localhost:4000  |

To work on a single app:

```bash
bun dev --filter @repo/api          # API only
bun dev --filter @repo/dashboard    # Dashboard only
bun dev --filter @repo/web          # Web only
```

## Project Structure

```
apps/
  web/            → Next.js marketing site (port 3000)
  dashboard/      → Next.js deployment dashboard (port 3001)
  api/            → Hono API engine (port 4000)
  cli/            → CLI tool (`openship deploy`)

packages/
  adapters/       → DockerAdapter (self-host) + OblienAdapter (cloud)
  core/           → Shared types, constants, utilities, errors
  db/             → Drizzle ORM schema + client + repositories
  ui/             → Shared React components (Tailwind)
```

All apps and packages extend `tsconfig.base.json` at the repo root.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`
- **Branches**: `feat/`, `fix/`, `docs/`, `chore/`
- **Code style**: Prettier — run `bun format` before committing
- **Types**: TypeScript strict mode everywhere

## API Module Pattern

Each API module lives in `apps/api/src/modules/<name>/` and follows this structure:

```
<name>.routes.ts        # Route definitions (Hono)
<name>.controller.ts    # Request handlers
<name>.service.ts       # Business logic
<name>.schema.ts        # TypeBox validation schemas
```

Shared modules (auth, projects, deployments, domains, webhooks, health) are always mounted. The `billing` module is **cloud-only** — it's only mounted when `CLOUD_MODE=true` in the environment.

## Adding a Cloud-Only Feature

If you're adding something that should only exist in the cloud version:

1. Gate it behind `CLOUD_MODE` in `apps/api/src/app.ts`
2. Make any required env vars (like Stripe keys) optional in `apps/api/src/config/env.ts`
3. Self-hosters should never see 500s from missing cloud config

## Database

```bash
bun db:generate     # Generate Drizzle migration files from schema
bun db:push         # Push schema to dev database (no migration file)
bun db:migrate      # Run pending migrations (production)
bun db:studio       # Open Drizzle Studio (database browser)
```

Schema lives in `packages/db/src/schema/`.

## Need Help?

Open an issue or start a discussion — happy to help!
