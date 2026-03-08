# System Layer — Server Setup & Provisioning

> Self-hosted only. Handles component detection, installation, and state caching.

## When Does This Run?

- **Cloud mode**: Never. `system` is `null`. Oblien manages everything.
- **Desktop mode**: Never. `system` is `null`. Local dev doesn't need server setup.
- **Self-hosted**: Active. `SystemManager` validates and provisions the server.

## Components by Runtime Mode

| Component | Docker mode | Bare mode |
|---|---|---|
| Docker Engine | Required | — |
| Git | Required | Required |
| Node.js | — | Required |
| Bun | — | Optional |
| Traefik | Required | Required |

## Setup Flow

```
Dashboard Setup Wizard
    │
    │  1. Collects InstallerConfig from user:
    │     • ACME email (for Let's Encrypt)
    │     • Domain (primary domain)
    │     • Traefik mode (file / docker)
    │
    ▼
SystemManager.setup(onLog, config)
    │
    │  Phase 1: CHECK — run health checks
    │     checkDocker(executor)  → "docker --version" + "docker info"
    │     checkGit(executor)     → "git --version"
    │     checkNode(executor)    → "node -v"
    │     checkTraefik(executor) → "traefik version" + systemctl status
    │
    │  Phase 2: INSTALL — install missing components
    │     installDocker(executor, onLog)  → curl get.docker.com | sh
    │     installTraefik(executor, onLog) → apt install + config files
    │     installNode(executor, onLog)    → curl nvm | sh
    │     (all stream real-time output via onLog callback)
    │
    │  Phase 3: VALIDATE — re-run checks
    │     Confirm everything is healthy after installation
    │
    │  Phase 4: CACHE — persist state
    │     SetupStateStore.set(state)
    │
    ▼
Server is ready → setupComplete: true
```

## State Caching

The system layer does **NOT** re-run checks on every request. State is cached.

### Hot Path (every request)

```typescript
// In service code before deploying:
await system.requireFeature("deploy");
// → reads in-memory cache → returns immediately (< 1ms)
```

### Cache Layers

```
┌──────────────────┐
│  In-memory cache  │ ← fastest, lives in SystemManager instance
│  (cachedState)    │
├──────────────────┤
│  SetupStateStore  │ ← file on disk or row in database
│  (persistent)     │    survives server restarts
└──────────────────┘
```

### Cache Invalidation

| Trigger | Behavior |
|---|---|
| First boot (no state) | `isReady()` returns false, forces setup |
| After `setup()` completes | State written with `setupComplete: true` |
| After 24 hours | Background re-verification (non-blocking) |
| Manual `invalidate()` | Clears both caches, next check runs fresh |
| Component failure | Service layer calls `invalidate()` |

### State Shape

```typescript
interface SetupState {
  setupComplete: boolean;
  mode: "docker" | "bare";
  components: Record<string, {
    installed: boolean;
    version?: string;
    installedAt?: string;
  }>;
  lastVerifiedAt?: string;
  updatedAt: string;
}
```

## Feature Gating

Features map to prerequisite components:

```typescript
// Docker mode rules
{ feature: "build",   requires: ["git", "docker"],  message: "Build requires Git and Docker" }
{ feature: "deploy",  requires: ["docker"],          message: "Deploy requires Docker" }
{ feature: "routing", requires: ["traefik"],          message: "Routing requires Traefik" }
{ feature: "ssl",     requires: ["traefik"],          message: "SSL requires Traefik with ACME" }

// Bare mode rules
{ feature: "build",   requires: ["git", "node"],     message: "Build requires Git and Node.js" }
{ feature: "deploy",  requires: ["node"],             message: "Deploy requires Node.js" }
{ feature: "routing", requires: ["traefik"],          message: "Routing requires Traefik" }
{ feature: "ssl",     requires: ["traefik"],          message: "SSL requires Traefik with ACME" }
```

Usage in service code:

```typescript
const { system } = platform();

// Guard a deployment
if (system) await system.requireFeature("deploy");
// → throws if Docker/Node not installed

// Check without throwing
if (system) {
  const { ready, missing } = await system.checkFeature("ssl");
  if (!ready) console.warn("SSL not available:", missing);
}
```

## InstallerConfig

Pre-collected from the user **before** starting setup. No interactive prompts during installation.

```typescript
interface InstallerConfig {
  /** Email for Let's Encrypt ACME registration */
  acmeEmail?: string;
  /** Primary domain for Traefik */
  domain?: string;
  /** Traefik provider mode */
  traefikMode?: "file" | "docker";
}
```

Validation:
- `acmeEmail` → basic email regex check
- `domain` → alphanumeric + dots, no shell-unsafe characters
- Values are **never** interpolated into shell strings without validation

## SetupStateStore

Pluggable storage backend:

```typescript
interface SetupStateStore {
  get(): Promise<SetupState | null>;
  set(state: SetupState): Promise<void>;
  clear(): Promise<void>;
}
```

| Implementation | Storage | Use Case |
|---|---|---|
| `FileStateStore` | JSON file via executor | Default, works everywhere |
| Custom DB store | Database row | API layer can provide one |

The `FileStateStore` uses the executor, so state files work on both local and remote servers.

## Important Design Decisions

1. **No system layer in cloud mode** — Oblien manages infrastructure. Zero RCE from the API.

2. **Checks run once, not per-request** — State is cached in memory + persistent store. Feature checks read cache.

3. **24h auto-reverification** — Stale cache triggers background re-check without blocking the current request.

4. **Non-interactive installers** — Config collected upfront. All install scripts run with `DEBIAN_FRONTEND=noninteractive`.

5. **All through executor** — Every shell command, every file read/write. Works identically local or over SSH.

6. **Log streaming** — Setup wizard shows real-time output via `onLog` callback → SSE to dashboard.
