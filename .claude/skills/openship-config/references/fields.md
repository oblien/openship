# `openship.json` — full field reference

Every field is optional. Present fields override auto-detection; absent fields keep the detected
value. Validated by `openship config validate` (same parser the deploy uses).

## Build

| Field | Type | Notes |
|---|---|---|
| `framework` | enum | Stack slug (see list below). Overrides detection. |
| `packageManager` | enum | `npm` `yarn` `pnpm` `bun` `go` `cargo` `pip` `poetry` `pipenv` `uv` `bundler` `composer` `maven` `gradle` `dotnet` `mix` |
| `rootDirectory` | string | App dir relative to repo root (e.g. `./`, `apps/web`). |
| `composePath` | string | Compose file outside the detected root — the file (`deploy/stack.yml`, which also covers non-standard names) or the folder holding it (`deploy/docker-compose`). Makes the project a compose deploy; `build:` contexts resolve relative to that folder, as compose does. |
| `installCommand` | string | Dependency install command. |
| `buildCommand` | string | Build command. |
| `startCommand` | string | Production start command. |
| `outputDirectory` | string | Build output dir (`dist`, `.next`, `build`, `out`, …). |
| `buildImage` | string | Build Docker image (e.g. `node:22`). |
| `productionPaths` | string[] | Paths shipped as the production artifact. |

**`framework` values:** `nextjs` `nuxt` `sveltekit` `remix` `astro` `vite` `angular` `gatsby`
`cra` `vue` `react` `express` `fastify` `hono` `nestjs` `koa` `adonis` `elysia` `go` `gin`
`fiber` `echo` `rust` `actix` `axum` `rocket` `python` `django` `flask` `fastapi` `rails`
`sinatra` `laravel` `symfony` `springboot` `quarkus` `kotlin` `dotnet` `blazor` `phoenix`
`node` `static` `docker` `docker-compose` `webmail`.

## Runtime

| Field | Type | Notes |
|---|---|---|
| `runtime` | `bare` \| `docker` | Runtime isolation for a single app. Services/docker projects are always `docker`. Seeds a new deploy's runtime. |
| `productionMode` | `host` \| `static` \| `standalone` | `static` ⇒ served as files, no server (sets `hasServer=false`). |
| `port` | integer 1–65535 | Server port. |
| `volumes` | string[] | Paths kept across deploys. Bare path = relative to the app (`storage`), or a full mount (`uploads:/app/storage`, `/srv/data:/app/var`). Omit to inherit the framework defaults (Laravel keeps `storage/`); `[]` turns persistence off. Compose services use `services[].volumes` instead. |

## Env

`env` is an object. A value is either a plain string, or `{ "value": string, "secret"?: boolean }`.
`secret: true` marks the variable for encryption at rest.

```json
"env": {
  "PUBLIC_URL": "https://app.acme.com",
  "API_KEY": { "value": "sk_live_…", "secret": true }
}
```

## Domains

`domains` is an array. Each entry is either a hostname string, or an object:

| Field | Type | Notes |
|---|---|---|
| `domain` | string | Hostname. Bare label = free subdomain; dotted = custom. |
| `port` | integer | Which port this hostname routes to. |
| `targetPath` | string | Path prefix on the target (default `/`). |
| `type` | `free` \| `custom` | Overrides the free/custom inference. |

## Routes

`routes` compiles to the reverse proxy at deploy.

| Field | Type | Notes |
|---|---|---|
| `rewrites` | `{ source, destination }[]` | Internal rewrites (e.g. SPA fallback). |
| `redirects` | `{ source, destination, permanent?, statusCode? }[]` | 3xx redirects. |
| `headers` | `{ source, headers: { key, value }[] }[]` | Response headers per path. |
| `cleanUrls` | boolean | Strip `.html`. |
| `trailingSlash` | boolean | Enforce/remove trailing slash. |

## Resources

`resources` is a named tier OR explicit values. Explicit values become the `custom` tier.

**Self-hosted defaults to `unlimited`** — no caps, because the machine is the operator's own and
is itself the ceiling. Only declare this to deliberately cap a container. A non-zero value is
validated against the TARGET MACHINE's real capacity, so a big box can be used fully. Cloud
workspaces are metered and must be sized: `unlimited` is rejected there and an omitted value
falls back to `low`.

| Field | Type | Range |
|---|---|---|
| `tier` | `unlimited` \| `micro` \| `low` \| `medium` \| `high` | `unlimited` is self-hosted only |
| `cpuCores` | number | `0` = no limit; otherwise ≥ 0.25, up to the machine's cores |
| `memoryMb` | integer | `0` = no limit; otherwise ≥ 128, up to the machine's RAM |
| `diskMb` | integer | `0` = no limit; otherwise 64–204800 (cloud workspaces only) |

## Services (compose)

`services` is an array; declaring it makes the project a multi-service (Docker) project.
To deploy an EXISTING compose file instead of re-declaring its services here, set
[`composePath`](#build) and leave `services` out.

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required.** |
| `image` | string | Prebuilt image (e.g. `postgres:17`). |
| `build` | string | Build context path. |
| `dockerfile` | string | Dockerfile path. |
| `ports` | string[] | e.g. `["3000"]`, `["5432:5432"]`. |
| `volumes` | string[] | e.g. `["pgdata:/var/lib/postgresql/data"]`. |
| `dependsOn` | string[] | Other service names. |
| `env` | env object | Same shape as top-level `env`. |
| `command` | string | Override the container command. |
| `restart` | `no` \| `always` \| `on-failure` \| `unless-stopped` | Restart policy. |
| `exposed` | boolean | Publicly routed. |
| `exposedPort` | string | Which container port is exposed. |
| `domain` | string | Public hostname for this service. |
| `healthcheck` | object | `{ test, interval, timeout, retries, startPeriod, disable }`. |
| `resources` | object | Per-service caps, overriding the top-level `resources` field by field. Same shape; `0` = no limit. |

A compose file's own `mem_limit` / `cpus` / `deploy.resources.limits` are read and applied the
same way — no need to restate them here.

## Monorepo

`monorepo` overrides detected sub-apps.

| Field | Type | Notes |
|---|---|---|
| `workspace.packageManager` | string | Root workspace package manager. |
| `workspace.prepareCommand` | string | Runs once at the repo root before per-app builds. |
| `apps[]` | array | Per-sub-app build overrides. |

Each `apps[]` entry (`name` + `rootDirectory` required) overrides the detected sub-app at that
`rootDirectory`. Supported overrides: `framework`, `packageManager`, `installCommand`,
`buildCommand`, `startCommand`, `outputDirectory`, `buildImage`, `port`. (Per-app `domain`/`env`
are set in the wizard, not here.)

## Not supported (do not add)

`sleepMode`, monorepo `sharedPaths`, and per-app `domain`/`env`/`exposed` are validated leniently
but **not applied** — leave them out.
