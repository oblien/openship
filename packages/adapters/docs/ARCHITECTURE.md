# Platform Architecture

> `@repo/adapters` — the abstraction layer between Openship's API and the underlying infrastructure.

## Three Deployment Targets

The same codebase runs in three completely different environments. The `createPlatform()` factory resolves the correct combination at startup based on config.

```
┌────────────────┬──────────────────────┬──────────────────────────┬─────────────────────┐
│                │  cloud (Oblien)      │  selfhosted              │  desktop            │
├────────────────┼──────────────────────┼──────────────────────────┼─────────────────────┤
│  Runtime       │  CloudRuntime        │  DockerRuntime or        │  BareRuntime        │
│                │  (pure API calls)    │  BareRuntime             │  (local executor)   │
├────────────────┼──────────────────────┼──────────────────────────┼─────────────────────┤
│  Routing       │  CloudInfraProvider  │  TraefikProvider         │  NoopInfraProvider  │
│                │  (pure API calls)    │  (writes YAML via exec)  │  (silent no-op)     │
├────────────────┼──────────────────────┼──────────────────────────┼─────────────────────┤
│  SSL           │  CloudInfraProvider  │  TraefikProvider (ACME)  │  NoopInfraProvider  │
│                │  (pure API calls)    │  (file ops via exec)     │  (no-op)            │
├────────────────┼──────────────────────┼──────────────────────────┼─────────────────────┤
│  System        │  null                │  SystemManager           │  null               │
│                │  (no RCE at all)     │  (checks + installers)   │  (no setup needed)  │
├────────────────┼──────────────────────┼──────────────────────────┼─────────────────────┤
│  Executor      │  null                │  LocalExecutor or        │  null               │
│                │  (nothing executes)  │  SshExecutor (shared)    │  (BareRuntime owns) │
├────────────────┼──────────────────────┼──────────────────────────┼─────────────────────┤
│  ssh2 loaded?  │  NO                  │  Only if SSH config set  │  NO                 │
└────────────────┴──────────────────────┴──────────────────────────┴─────────────────────┘
```

## Three Layers

Each layer has a single responsibility. They are composed by the Platform, never used directly.

### 1. Runtime — build/deploy/stop lifecycle

| Class | Transport | Use Case |
|---|---|---|
| `DockerRuntime` | dockerode (socket / SSH / TLS) | Self-hosted with Docker |
| `BareRuntime` | `CommandExecutor` (local or SSH) | Self-hosted bare metal, desktop |
| `CloudRuntime` | HTTP API calls (Oblien SDK) | Oblien cloud |

- Docker has its **own** SSH transport via dockerode — separate from the shared executor
- Bare uses the **shared** executor for everything (git, npm, nohup, kill, PID files)
- Cloud makes **zero** local calls — pure API stubs

### 2. Infra — routing + SSL

| Class | Transport | Use Case |
|---|---|---|
| `TraefikProvider` | `CommandExecutor` (dual-path) | Self-hosted |
| `CloudInfraProvider` | HTTP API calls (Oblien SDK) | Oblien cloud |
| `NoopInfraProvider` | Nothing | Desktop / dev |

- Traefik writes YAML config files to a watched directory via the executor
- SSL is Traefik's built-in ACME resolver — cert info read via the executor
- The executor enables Traefik config to be written on the local machine OR a remote server via SSH

### 3. System — prerequisite checks + server setup

| Class | Transport | Use Case |
|---|---|---|
| `SystemManager` | `CommandExecutor` | Self-hosted only |
| _null_ | — | Cloud and Desktop (no setup needed) |

- Checks: docker, traefik, git, node, bun — all via executor
- Installers: automated install scripts with real-time log streaming
- State: cached in `SetupStateStore` (file or DB), 24h auto-reverification
- Feature gating: `requireFeature("deploy")` reads cached state (free on hot paths)

## File Map

```
src/
├── types.ts              # Shared types: configs, CommandExecutor, SshConfig
├── platform.ts           # Factory + singleton (createPlatform, getPlatform)
├── index.ts              # Barrel exports
│
├── runtime/
│   ├── types.ts          # RuntimeAdapter interface, RuntimeCapability
│   ├── docker.ts         # DockerRuntime (dockerode)
│   ├── bare.ts           # BareRuntime (executor-based)
│   ├── cloud.ts          # CloudRuntime (API stubs)
│   └── index.ts          # Factory + re-exports
│
├── infra/
│   ├── types.ts          # RoutingProvider, SslProvider interfaces
│   ├── traefik.ts        # Traefik file provider (dual-path via executor)
│   ├── cloud.ts          # Cloud infra (API stubs)
│   └── noop.ts           # No-op (desktop/dev)
│
└── system/
    ├── types.ts          # SystemLog, ComponentStatus, InstallerConfig, etc.
    ├── executor.ts       # LocalExecutor, SshExecutor, createExecutor()
    ├── state.ts          # SetupStateStore interface, FileStateStore
    ├── checks.ts         # Component health checks (all via executor)
    ├── installer.ts      # Component installers (all via executor)
    ├── setup.ts          # SystemManager orchestrator
    └── index.ts          # Barrel exports
```

## How It's Wired

```
┌─────────────────────────────────────────────────────────────────┐
│  API (apps/api)                                                 │
│                                                                 │
│  app.ts:  bootstrapPlatform()                                   │
│           │                                                     │
│           ▼                                                     │
│  controller-helpers.ts:  resolveConfig() → initPlatform()       │
│                          platform() → getPlatform()             │
│                                                                 │
│  service code:  const { runtime, routing, ssl } = platform()    │
│                 await runtime.build(config, onLog)               │
│                 await routing.registerRoute({ domain, ... })    │
│                 await ssl.provisionCert(domain)                 │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  @repo/adapters                                                 │
│                                                                 │
│  createPlatform(config) ─┬─ "cloud"      → CloudRuntime        │
│                          │                + CloudInfraProvider   │
│                          │                + system: null         │
│                          │                + executor: null       │
│                          │                                      │
│                          ├─ "selfhosted" → Docker/BareRuntime   │
│                          │                + TraefikProvider      │
│                          │                + SystemManager        │
│                          │                + executor ─┐         │
│                          │                            │         │
│                          │    ┌───────────────────────┘         │
│                          │    │ shared across:                  │
│                          │    │  • BareRuntime (if bare mode)   │
│                          │    │  • TraefikProvider              │
│                          │    │  • SystemManager                │
│                          │    │  • checks.ts + installer.ts     │
│                          │                                      │
│                          └─ "desktop"    → BareRuntime (own)    │
│                                           + NoopInfraProvider   │
│                                           + system: null        │
│                                           + executor: null      │
└─────────────────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Values | Effect |
|---|---|---|
| `CLOUD_MODE` | `true` / `false` | Force cloud target (overrides DEPLOY_MODE) |
| `DEPLOY_MODE` | `docker` / `bare` / `cloud` / `desktop` | Select runtime + target |

Resolution priority in `resolveConfig()`:
1. `CLOUD_MODE=true` or `DEPLOY_MODE=cloud` → `target: "cloud"`
2. `DEPLOY_MODE=desktop` → `target: "desktop"`
3. Everything else → `target: "selfhosted"` + `runtime: DEPLOY_MODE`
4. Default (nothing set) → `target: "selfhosted"`, `runtime: "docker"`
