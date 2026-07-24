# Contributing to Openship

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Before you open a pull request

**Bug fixes, tests, docs, and small self-contained improvements** are welcome as direct pull
requests — no need to ask first.

**New features, behavior changes, new dependencies, new endpoints, schema/migration changes, or
anything architectural** must start as an **issue** so we can agree on the feature *and* the
approach *before* any code is written. A PR for one of these without an agreed issue will likely be
closed unmerged — not because the idea is bad, but because settling direction after the code exists
wastes your effort and ours. The flow:

1. Open an issue describing the problem, the change you propose, and how you'd approach it.
2. Wait for a maintainer to agree on scope + approach (usually quick).
3. Implement it, and link the issue in your PR.

If you're unsure whether something counts as a "fix" or a "feature," open an issue and ask — that's
always the cheaper path.

### Pull request quality bar

Every PR is reviewed by a human, so make it easy to trust:

- **One change per PR.** One bug, or one agreed feature. Don't bundle unrelated changes.
- **Scope the diff.** Touch only the files your change needs. Do **not** reformat unrelated lines
  or "fix" pre-existing Prettier/lint drift on lines you aren't otherwise changing — run
  `bun format`, then review the diff and drop anything unrelated before you push.
- **Explain the why.** State what was broken (or what the linked issue agreed), and exactly how you
  verified it — the commands you ran and the before/after behavior.
- **Prove it.** Add a test that fails without your change and passes with it, and say so in the PR.
- **Green before you open.** `bun run test`, the relevant typecheck (`bun run --cwd <workspace>
  lint`), and `bun format` all pass locally.

### Using AI assistants

AI tools are fine to use — but **you** are the author and are accountable for every line you submit:

- **Understand your whole diff.** If you can't explain a line in review, don't submit it.
- **Verify, don't trust.** Actually run the change and confirm it does what the PR claims. Do not
  paste generated code — or a generated PR description — that you haven't checked against the real
  codebase.
- **Keep it real and scoped.** The PRs that waste the most review time are plausible-looking but
  unverified: invented/nonexistent APIs, fixes for bugs that don't exist, sweeping reformats, or
  duplicates of open work. Low-effort, speculative, or spammy PRs (AI-generated or not) are closed
  on sight.

A focused, verified, well-explained PR — AI-assisted or not — is exactly what we want.

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
