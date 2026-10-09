# Managed Cloud deployment compatibility

Openship Cloud builds and runs applications on isolated containers and serves static output through Pages. Importing `vercel.json` is a configuration compatibility feature; it does not provide Vercel's Functions, Edge runtime or storage APIs.

## Automatic Node behavior

For generated Cloud Node images, Openship selects a compatible image from `package.json`'s `engines.node` requirement. The default major is retained if the complete major satisfies the range; otherwise a compatible major, minor or exact version is selected. An explicit project image remains authoritative. Build and runtime retain the same official Node image pin. Bun retains its own runtime.

A managed Node runtime adapter makes an application's declared public ports reachable when its Node server binds to `localhost`, `127.0.0.1` or `::1`. It adapts `net.Server.listen()` at runtime, supporting positional and options-object signatures. This covers Node HTTP/HTTPS servers and frameworks using those APIs. It does not edit repository files, alter ports, scan for services, use host networking or create another proxy container.

Only ports published for that workload are adapted. Other private listeners, Unix sockets, handles, ephemeral port-zero listeners and explicit non-loopback bind addresses retain their behavior. The public port must still agree with the application; Openship does not guess which of several servers should be public. The adapter is activated by the Cloud runtime, remains active across environment refreshes, and preserves existing `NODE_OPTIONS`. Build/install commands execute before the runtime adapter is installed.

Static builds, workers without published ports, custom Dockerfiles, prebuilt images and non-Node runtimes keep their existing startup contracts. A custom Dockerfile should bind its public service to `0.0.0.0` or an equivalent reachable interface. Exporting a generated image outside Cloud does not activate the listener adaptation unless its managed public-port environment is retained.

## Imported configuration

| Configuration                                                                        | Behavior                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installCommand`, `buildCommand`                                                     | Imported; explicit empty strings disable the step and are represented internally as a shell no-op.                                                                  |
| `outputDirectory`, supported `framework` presets                                     | Used during detection. Explicit native Openship configuration takes precedence over imported metadata.                                                              |
| `rewrites`, `redirects`                                                              | Supported literal paths and the shared compiler's trailing wildcard/capture syntax are compiled for the Cloud edge. Unsupported syntax is reported by the compiler. |
| `headers`                                                                            | Safe literal header names/values, with exact literal-path matches and supported prefix wildcard matches.                                                            |
| `cleanUrls`, `trailingSlash`                                                         | Compiled to the edge's URL policies.                                                                                                                                |
| Conditional `has` / `missing` rules                                                  | Not imported as unconditional rules; surfaced as configuration warnings.                                                                                            |
| `functions`, legacy `builds` / `routes`, `regions`, `crons`, `env`, `build`, `fluid` | Not emulated; surfaced as compatibility warnings. Configure the corresponding Openship feature where available.                                                     |

This is a supported subset, not a promise to execute every Vercel project unchanged. Middleware, framework-specific platform APIs, custom regular expressions, function packaging, scheduling and external services require their own compatible implementation. Review configuration diagnostics before deployment.

For example, a `server.mjs` using Node SQLite is a server application even if it also has a `public` directory. The application must run to answer `/api/*`; serving its static assets alone cannot supply that API. Persistent SQLite also requires a persistent volume and an application-configured database path. Openship does not infer which arbitrary files should survive deployments or manufacture missing provider credentials.

## Deployment and verification

Cloud web deployments include their configured managed hostname in the route plan. Replacing a container republishes the edge route against its current host port; this is independent of local OpenResty routing. Readiness configuration remains explicit and is preserved.

Regression coverage includes Node engine ranges, runtime image pins, real Node listener behavior, Cloud environment activation/refresh, metadata precedence, conditional-rule diagnostics, exact headers, and managed hostname planning. An isolated Docker network check also verifies that the unchanged localhost-bound public listener is reachable through port publishing while an unconfigured private listener remains inaccessible.

## Package-manager versions and private catalog apps

Managed pnpm builds honor an exact `packageManager` pin, including Corepack integrity hashes, or an exact `devEngines.packageManager` version. For an unpinned repository, the nearest pnpm lockfile selects a fixed compatible version: lockfile 9 uses pnpm 9.15.9, lockfile 6 uses 8.15.9, lockfile 5.4 uses 7.33.7, and lockfile 5.3 uses 6.35.1. Without a lockfile the default is 9.15.9. Unknown formats and ambiguous explicit requirements fail with an instruction to pin the intended version. This avoids fetching a new major merely because Corepack's registry default changed. Parent manifest pins are respected for monorepos.

The bootstrap does not edit repository manifests, approve dependency scripts or disable repository script policies. A project explicitly pinned to a newer pnpm version retains that version and its approval requirements. An unpinned project declaring a dependency-script approval policy must pin its pnpm version rather than have Openship guess which policy semantics apply. Custom Dockerfiles still own their package-manager setup.

Catalog HTTP apps on Cloud default to domain access. The explicit **No domain** choice keeps the endpoint private on the app network; it does not publish a raw host port. Cloud saves no host-port mapping for these endpoint choices, including when correcting an existing draft. A chosen free/custom domain creates the public endpoint; private databases remain private. Connected self-hosted servers retain their fixed port-only bindings. Existing deployed apps are not automatically exposed or rewritten by this change.

## Shared JavaScript package-manager contract

Generated npm, pnpm, Yarn and Bun builds use the same discovery, installation and verification flow. An explicit `packageManager` or exact `devEngines.packageManager` declaration wins over stale lockfiles. The bootstrap walks parent manifests for monorepos, preserves repository files and script policy, installs the selected tool, and verifies its actual `--version`. A successful installer with a different executable on PATH fails the build rather than silently continuing.

Unpinned npm uses 9.9.4; Bun uses 1.3.14; Yarn Classic uses 1.22.22. Yarn lockfile metadata versions 4, 6 and 8 select 2.4.3, 3.8.7 and 4.9.2 respectively. pnpm retains the lockfile mapping above. Repository-local Yarn paths are inspected and must agree with any explicit pin. Unsupported lockfiles or non-exact declarations require an explicit supported pin.

Corepack installs pnpm/Yarn when available. Its fallback uses the same selected version through npm, with `@yarnpkg/cli-dist` for modern Yarn. npm and Bun reuse an exact installed version or install the requested one. A Bun-only environment obtains the exact official platform binary without running dependency scripts, verifies it, and atomically replaces the tool executable. Bun's generated build image uses the declared version, and runtime selection preserves official Bun image pins, variants and digests.

Corepack-qualified integrity pins are retained for npm/pnpm/Yarn and never discarded during fallback. Integrity-qualified Bun declarations are explicitly unsupported by this bootstrap; use a custom verified toolchain instead. Custom Dockerfiles own their toolchain. Python, Ruby, Go and other language package managers are unchanged; this contract does not claim cross-ecosystem compatibility.

### Maintaining the package-manager bootstrap

The managed bootstrap is authored as typed modules in `packages/core/src/package-manager/`.
Discovery collects repository settings, resolution selects an exact version, manager-specific
installers prepare it, and verification checks the executable used by the build. The declaration
parser is shared with stack detection.

After changing these modules or the shared version parser/defaults, run
`bun run --cwd packages/core generate:bootstrap` with the repository-pinned Bun and commit the
updated `package-manager-bootstrap.generated.ts`. The core test suite checks that the bundled
script matches its sources and exercises that script through the generated shell command.
The checked-in bundle keeps deployment command generation synchronous and usable in the API,
dashboard, desktop, and SDK without a compiler or source files on the build host. Generated code
is an output artifact; edit the typed modules instead.

### Managed Cloud startup verification

Cloud container deployments automatically run a short startup stabilization check before being
reported ready. Single applications, private services, and workers use the same container-state
checks as Compose stacks. A confirmed crash loop, failed exit, or unhealthy container fails the
affected deployment/service and includes available exit details and recent logs. Compose services
are checked together after their peers start; successful one-shot jobs are accepted.

The default observation window is 15 seconds, with early success when Docker reports healthy.
A longer configured stabilization window is honored. Custom TCP/HTTP readiness remains opt-in,
and its `onFailure` policy does not turn a confirmed Cloud startup crash into a warning. Static
Cloud Pages has no running container and skips this check. Non-Cloud targets retain opt-in checks.
If the runtime cannot be inspected, the deployment carries a verification warning rather than
claiming that the application crashed. This startup check does not guarantee ongoing health or
validate business operations such as database-backed requests; use a custom readiness endpoint
when those must gate a deployment.

## Legacy route cleanup

Older deleted projects can leave route cleanup records without a server binding
or a provider resource identity. In Cloud, these records are reconciled against
an account-wide, read-only provider inventory, including disabled Pages, edge
proxies and tunnels. Cleanup does not open a VM runtime or infer permission to
delete a provider resource from a hostname alone.

A confirmed absent hostname permits an atomic retirement of the legacy cleanup
record. The database still requires the original project to be gone, the record
to remain unbound, and no physical host-port claim to remain. Pending workload
cleanup blocks reconciliation. Current domain rows are preserved. An existing
provider owner or an unavailable/incomplete inventory retains the reservation
and produces a diagnostic for follow-up. This is retryable database
reconciliation, not a distributed transaction with the provider.
