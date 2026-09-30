# OpenShip Mobile (`@repo/mobile`)

Mobile client for [Openship](https://github.com/oblien/openship) — the open-source, self-hostable deployment platform. Built with Kotlin Multiplatform and Compose Multiplatform for Android.

## Features

| Area | Description |
|---|---|
| **Connect** | Connect to self-hosted or cloud OpenShip instances via URL + Personal Access Token. |
| **Projects** | Real-time overview of projects and active deployment statuses. |
| **Live Deploy Logs** | SSE log streaming with ANSI color decoding, step progress, and auto-scroll. |
| **Server Monitoring** | Real-time CPU, RAM, disk, and load telemetry with sparklines for self-hosted instances. |
| **Redeploy & Rollback** | Deployment control via the OpenShip MCP endpoint (`/api/mcp`). |
| **Themes** | Dark, dim, and light modes matching OpenShip dashboard design tokens. |

## Quick Start (Monorepo)

From the repository root:

```bash
# Build release APKs
bun run build:mobile

# Or from apps/mobile directory:
cd apps/mobile
./gradlew assembleDebug
```

### Point the app at Openship

1. Run Openship (`bun install && bun dev` in the Openship repo). API default: `http://localhost:4000`.
2. Create a PAT in the dashboard: **Settings → API Tokens**.
3. In the app:
   - **Emulator:** `http://10.0.2.2:4000` (host loopback)
   - **USB device:** app install runs `adb reverse` for ports `4000` / `20000`, or use your LAN IP
   - **Sideloaded APKs** (installed outside Gradle) don't get this: run `adb reverse tcp:4000 tcp:4000` manually, or use `http://<lan-ip>:4000`. Reverse rules are also cleared whenever USB reconnects.
   - **Wi‑Fi device:** `http://<your-machine-lan-ip>:4000`

Cleartext HTTP is allowed for local/LAN self-hosting via `network_security_config.xml`. Prefer HTTPS for anything beyond your network.

### Build & test

```bash
./gradlew :androidApp:assembleDebug
./gradlew :shared:allTests
./gradlew :androidApp:testDebugUnitTest
```

### Release APKs (per ABI)

Release builds use **R8 minify + resource shrink** and **ABI splits** (no fat universal APK).

```bash
./gradlew :androidApp:assembleRelease
# outputs: androidApp/build/outputs/apk/release/androidApp-<abi>-release-*.apk
# typical size: ~5 MB each (vs ~26 MB unminified debug)
```

| ABI              | Devices                        |
| ---------------- | ------------------------------ |
| `arm64-v8a`      | Most phones (default download) |
| `armeabi-v7a`    | Older 32-bit ARM               |
| `x86` / `x86_64` | Emulators                      |

Optional signing (otherwise APKs are unsigned — fine for local install with `adb install -r` after `zipalign`/`apksigner`, or set):

```bash
# env or signing.properties (gitignored)
OPENSHIP_STORE_FILE=/path/to/upload.jks
OPENSHIP_STORE_PASSWORD=...
OPENSHIP_KEY_ALIAS=...
OPENSHIP_KEY_PASSWORD=...
```

### CI Releases

Pushing a tag (`v*`, e.g. `v0.2.0` — must match `versionName`) triggers [.github/workflows/release.yml](.github/workflows/release.yml): runs unit tests, builds the per-ABI release APKs, and publishes a GitHub Release with them plus the R8 `mapping.txt`.

For signed releases, add these repo secrets: `ANDROID_KEYSTORE_BASE64` (base64 of your keystore), `OPENSHIP_STORE_PASSWORD`, `OPENSHIP_KEY_ALIAS`, `OPENSHIP_KEY_PASSWORD`. Without secrets the workflow still publishes unsigned APKs.

Play Store: prefer `./gradlew :androidApp:bundleRelease` (AAB); ABI/language/density splits stay enabled in the bundle.

## Stack

| Piece         | Choice                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| Language / UI | Kotlin 2.4, Compose Multiplatform 1.11                                                   |
| Modules       | `:androidApp` host + `:shared` KMP library                                               |
| HTTP / SSE    | Ktor 3.5 (OkHttp on Android)                                                             |
| Actions       | [Kotlin MCP SDK](https://github.com/modelcontextprotocol/kotlin-sdk) client → `/api/mcp` |
| DI            | Koin 4                                                                                   |
| Secrets       | AndroidX Security Crypto                                                                 |

## Architecture (short)

```
androidApp/     → Application, Activity, Android Koin wiring
shared/
  commonMain/   → REST + SSE + MCP, models, ViewModels, Compose UI
  androidMain/  → OkHttp engine, EncryptedSharedPreferences
```

- **REST + SSE** for discovery, projects, live logs, monitoring
- **MCP** for curated write actions (redeploy, rollback) with runtime tool discovery
- **REST + SSE** for discovery, projects, live logs, monitoring
- **MCP** for curated write actions (redeploy, rollback) with runtime tool discovery
- One shared `HttpClient`; PAT only in `Authorization` headers (no query-string tokens)

## Security

- PATs stay securely on-device (hardware Keystore-backed AES-256 GCM). No middleman backend.
- Cleartext HTTP is restricted to local private IP subnets (`network_security_config.xml`).
- Network requests use tolerant JSON serializers and strict SSL validation by default.

## License

[Apache License 2.0](../../LICENSE)
