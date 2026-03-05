# Contributing to Openship

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Fork & clone** the repository
2. **Install dependencies**: `pnpm install`
3. **Set up env**: `cp .env.example .env`
4. **Generate DB client**: `pnpm db:generate`
5. **Start dev**: `pnpm dev`

## Project Structure

- `apps/*` — Deployable applications (web, dashboard, api, cli)
- `packages/*` — Shared libraries consumed by apps
- `tooling/*` — Build and lint configurations

## Conventions

- **Commits**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
- **Branches**: `feat/`, `fix/`, `docs/`, `chore/`
- **Code style**: Prettier is configured — run `pnpm format` before committing
- **Types**: TypeScript strict mode is enabled everywhere

## API Module Pattern

Each API module follows this structure:

```
modules/<name>/
  ├── <name>.routes.ts      # Route definitions
  ├── <name>.controller.ts   # Request handlers
  ├── <name>.service.ts      # Business logic
  └── <name>.schema.ts       # Zod validation schemas
```

## Need Help?

Open an issue or start a discussion — we're happy to help!
