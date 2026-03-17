# Cloud Architecture

> How Openship connects to Oblien cloud infrastructure — same pipeline, two auth paths.

## Overview

Openship runs in two modes. Both use the **exact same** `CloudRuntime` and build/deploy pipeline. The only difference is how the Oblien SDK client gets authenticated:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CloudRuntime(client)                           │
│                                                                        │
│   build() → provisionBuildWorkspace → runBuildPipeline → deploy()     │
│   stop() / start() / restart() / destroy()                            │
│   logs / metrics / domain management                                   │
│                                                                        │
│   Doesn't know or care HOW the Oblien client was authenticated.       │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
   ┌──────────▼──────────┐      ┌───────────▼───────────┐
   │  SaaS (CLOUD_MODE)  │      │  Local (!CLOUD_MODE)  │
   │                     │      │                        │
   │  Master credentials │      │  Namespace token       │
   │  clientId + secret  │      │  from stored session   │
   │                     │      │                        │
   │  new Oblien({       │      │  new Oblien({          │
   │    clientId,        │      │    token               │
   │    clientSecret     │      │  })                    │
   │  })                 │      │                        │
   │                     │      │  Scoped to user's      │
   │  Full platform      │      │  namespace (os-{uid})  │
   │  access             │      │  30min TTL             │
   └─────────────────────┘      └────────────────────────┘
```

## Mode 1: SaaS (`CLOUD_MODE=true`)

When Openship runs as the hosted SaaS platform (api.openship.io):

```
Server startup
  → initPlatform({ target: "cloud", cloudClientId, cloudClientSecret })
  → new Oblien({ clientId, clientSecret })       ← master creds from env
  → CloudRuntime(client)                          ← singleton, stays for process lifetime
  → build.service.ts uses platform().runtime directly
```

The SaaS also exposes a token endpoint for local instances:

```
POST /api/cloud/token  (requires auth)
  → ensureNamespace(userId)    ← creates os-{userId} namespace if needed
  → client.tokens.create({ scope: "namespace", namespace, ttl: 1800 })
  → { token, namespace, expiresAt }
```

### Key files

| File | Purpose |
|---|---|
| `apps/api/src/lib/openship-cloud.ts` | `ensureNamespace()` + `issueNamespaceToken()` |
| `apps/api/src/modules/cloud/cloud.controller.ts` | `getToken()` handler |
| `apps/api/src/modules/cloud/cloud.routes.ts` | `cloudSaasRoutes` → `POST /token` |

## Mode 2: Local (`CLOUD_MODE=false`)

When Openship runs locally (desktop app, self-hosted, CLI):

### Step 1: User connects their Openship Cloud account

```
Dashboard Settings page
  → user enters email + password
  → POST /api/cloud/connect
  → Local API proxies login to api.openship.io/api/auth/sign-in/email
  → Receives session token
  → Encrypts + stores in user_settings.cloud_session_token
```

### Step 2: Deploy to cloud

```
build.service.ts → executeBuildAndDeploy()
  → detects !CLOUD_MODE && target === "cloud"
  → getCloudToken(userId)
      → reads encrypted session from DB
      → POST api.openship.io/api/cloud/token (with Bearer session)
      → receives namespace-scoped Oblien token (cached in memory, 30min TTL)
  → createPlatform({ target: "cloud", cloudToken: result.token })
      → new Oblien({ token })                  ← namespace-scoped
      → CloudRuntime(client)                    ← per-deploy instance
  → same build() → same deploy() → same everything
```

### Key files

| File | Purpose |
|---|---|
| `apps/api/src/lib/cloud-client.ts` | `connectCloud()`, `disconnectCloud()`, `isCloudConnected()`, `getCloudToken()` |
| `apps/api/src/modules/cloud/cloud.controller.ts` | `connect()`, `disconnect()`, `status()` handlers |
| `apps/api/src/modules/cloud/cloud.routes.ts` | `cloudLocalRoutes` → `POST /connect`, `POST /disconnect`, `GET /status` |
| `apps/dashboard/src/app/(dashboard)/settings/page.tsx` | Cloud connection UI |
| `apps/dashboard/src/lib/api/cloud.ts` | `cloudApi` client-side helpers |

## Auth Flow Diagram

```
LOCAL MODE — full round trip:

┌──────────────┐     POST /api/cloud/connect
│  Dashboard   │ ──────────────────────────────▶ ┌──────────────┐
│  Settings    │     { email, password }          │  Local API   │
│              │                                  │              │
│              │     { connected: true }           │  cloud       │
│              │ ◀────────────────────────────────│  controller  │
└──────────────┘                                  └──────┬───────┘
                                                         │
                               POST /api/auth/sign-in    │
                               { email, password }       │
                                                         ▼
                                                  ┌──────────────┐
                                                  │ Openship     │
                                                  │ Cloud SaaS   │
                                                  │              │
                                                  │ Returns      │
                                                  │ session token│
                                                  └──────────────┘
                                                         │
                                          encrypt(token) │
                                          store in DB    │
                                                         ▼
                                                  ┌──────────────┐
                                                  │ user_settings│
                                                  │ cloud_session│
                                                  │ _token (enc) │
                                                  └──────────────┘


DEPLOY TIME:

┌──────────────┐                                  ┌──────────────┐
│ build.service│ ── getCloudToken(userId) ──────▶ │ cloud-client │
│              │                                  │              │
│              │                                  │ 1. read DB   │
│              │                                  │ 2. decrypt   │
│              │     { token, namespace }          │ 3. POST /api │
│              │ ◀────────────────────────────────│    /cloud    │
└──────┬───────┘                                  │    /token    │
       │                                          └──────┬───────┘
       │  createPlatform({                               │
       │    target: "cloud",                              ▼
       │    cloudToken: token             ┌──────────────────────────┐
       │  })                              │ Openship Cloud SaaS      │
       │                                  │                          │
       ▼                                  │ ensureNamespace(userId)  │
┌──────────────┐                          │ issueNamespaceToken()    │
│ CloudRuntime │                          │                          │
│              │                          │ Returns Oblien namespace │
│ new Oblien({ │                          │ token (30min TTL)        │
│   token      │                          └──────────────────────────┘
│ })           │
│              │
│ build()      │──────▶ Oblien API (workspaces, runtime, deploy...)
│ deploy()     │
└──────────────┘
```

## Namespace Model

Each user gets an isolated Oblien namespace:

- **Slug**: `os-{userId}`
- **Creation**: Idempotent — 409 on duplicate is caught, existing namespace fetched
- **Cached**: In-memory `Map<userId, slug>` on SaaS server

The namespace token gives full access to everything in that namespace:
- Create/manage workspaces
- Build & deploy
- Domain management
- Logs & metrics

## Security

| Concern | Approach |
|---|---|
| Cloud session at rest | AES-256 encrypted via `encrypt()`/`decrypt()` in `encryption.ts` |
| Session in transit | HTTPS only (api.openship.io) |
| Expired sessions | Auto-cleared on 401 from SaaS API |
| Namespace tokens | 30min TTL, 5min refresh buffer, in-memory cache only |
| Token scope | Namespace-scoped — user can only access their own resources |
| No browser cookies | Session lives server-side in DB, never exposed to dashboard |

## API Endpoints

### SaaS routes (`CLOUD_MODE=true`, mounted at `/api/cloud`)

| Method | Path | Handler | Purpose |
|---|---|---|---|
| POST | `/token` | `getToken` | Mint namespace-scoped Oblien token |

### Local routes (`CLOUD_MODE=false`, mounted at `/api/cloud`)

| Method | Path | Handler | Purpose |
|---|---|---|---|
| POST | `/connect` | `connect` | Proxy login → store encrypted session |
| POST | `/disconnect` | `disconnect` | Clear stored session |
| GET | `/status` | `status` | Check connection state |

### Dashboard API (`apps/dashboard/src/lib/api/cloud.ts`)

```typescript
cloudApi.connect(email, password)  // POST /api/cloud/connect
cloudApi.disconnect()              // POST /api/cloud/disconnect
cloudApi.status()                  // GET  /api/cloud/status
```

## Route Mounting (`app.ts`)

```typescript
if (env.CLOUD_MODE) {
  // SaaS: mint tokens for local instances
  app.route("/api/cloud", cloudSaasRoutes);
} else {
  // Local: manage connection to Openship Cloud
  app.route("/api/cloud", cloudLocalRoutes);
}
```

Dynamic imports ensure zero code bleed between modes.

## Database

| Table | Column | Type | Purpose |
|---|---|---|---|
| `user_settings` | `cloud_session_token` | `text` (nullable) | Encrypted Openship Cloud session |

Migration: `packages/db/drizzle/0004_add_cloud_session_token.sql`
