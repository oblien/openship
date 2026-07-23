# Contributing to Openship

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Bun 1.3.10](https://bun.sh/) (pinned in `.bun-version` and `package.json`)
- [Node.js 22 or newer](https://nodejs.org/) (see `.nvmrc` and `package.json`)
- Docker, when using the Compose stack or testing Docker-based deployments

## Development Setup

```bash
git clone https://github.com/oblien/openship.git
cd openship
bun install --frozen-lockfile
cp apps/api/.env.example apps/api/.env
cp apps/dashboard/.env.example apps/dashboard/.env
bun dev:local
```

This starts the API and dashboard used for local development:

| Service   | URL                   |
| --------- | --------------------- |
| Dashboard | http://localhost:3001 |
| API       | http://localhost:4000 |

Use the root scripts to run a different workspace or the full development graph:

```bash
bun dev:api          # API and its workspace dependencies
bun dev:dashboard    # Dashboard only
bun dev:web          # Marketing site (http://localhost:3009)
bun dev:desktop      # Electron desktop app
bun dev:email        # Email server and client
bun dev              # All workspace dev tasks
```

The root `.env.example` is for the Docker Compose stack. To run that stack instead, copy it
to `.env` and run `docker compose up -d --build`. Compose starts PostgreSQL, Redis, the API,
the dashboard, and the web app; its web app is exposed at `http://localhost:3000`.

## Project Structure

```
apps/
  api/            → Hono API engine (port 4000)
  cli/            → CLI tool (`openship deploy`)
  dashboard/      → Next.js deployment dashboard (port 3001)
  desktop/        → Electron desktop app and local service launcher
  email/          → Email engine and Zero server/client orchestrator
  web/            → Next.js marketing site (port 3009 in development)

packages/
  adapters/       → Docker, bare, and cloud runtimes plus infrastructure adapters
  core/           → Shared types, constants, utilities, errors
  db/             → Drizzle ORM schema + client + repositories
  db-email/       → Email-server Drizzle schemas + client
  onboarding/     → Shared onboarding flows, validation, and API client
  ui/             → Shared React components (Tailwind)
```

Most workspaces extend `tsconfig.base.json` at the repo root. The email client and server
maintain their own strict TypeScript configurations.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) - `feat:`, `fix:`, `docs:`, `chore:`
- **Branches**: `feat/`, `fix/`, `docs/`, `chore/`
- **Code style**: Prettier - run `bun format` before committing
- **Types**: TypeScript strict mode everywhere

## Localization

Dashboard dictionaries live in `apps/dashboard/src/i18n/locales/<locale>/`. When adding or
updating a locale:

1. Keep the same files, nested keys, and interpolation placeholders (for example `{name}`)
   as the English dictionaries in `apps/dashboard/src/i18n/locales/en/`.
2. Register the locale in `apps/dashboard/src/i18n/index.ts` and expose it in the dashboard
   and onboarding language selectors.
3. Add a translated README under `docs/i18n/README.<locale>.md`, then add its language badge
   to the root README and every localized README.
4. Preserve product names, commands, URLs, code blocks, and established technical terms.
5. Run the dashboard tests, TypeScript check, and Prettier before submitting the change.

## API Module Pattern

Each API module lives in `apps/api/src/modules/<name>/` and follows this structure:

```
<name>.routes.ts        # Route definitions (Hono)
<name>.controller.ts    # Request handlers
<name>.service.ts       # Business logic
<name>.schema.ts        # TypeBox validation schemas
```

Shared modules (auth, projects, deployments, domains, webhooks, health) are always mounted. The `billing` module is **cloud-only** - it's only mounted when `CLOUD_MODE=true` in the environment.

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
bun run --cwd packages/db db:studio  # Open Drizzle Studio (database browser)
```

Schema lives in `packages/db/src/schema/`.

## Verification

The root test and build scripts run the corresponding tasks across the workspaces that
define them:

```bash
bun run test
bun run build
```

Run workspace checks directly when working on a single area. For example, the API typecheck
is `bun run --cwd apps/api lint`. Run `bun format` before committing and review the resulting
diff so unrelated files are not included.

## Need Help?

Open an issue or start a discussion - happy to help!
