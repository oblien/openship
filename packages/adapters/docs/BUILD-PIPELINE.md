# Build Pipeline & Process Management

> How builds run, how processes are tracked, and how cleanup works across all runtimes.

## Build Flow

All three runtimes implement `build()` but with completely different transports:

```
build.service.ts
    │
    │  Creates BuildLogger (single source of truth for all log emission)
    │  Creates logCallback → pushes to logs[] + SSE broadcast
    │
    ▼
runtime.build(config, logger)
    │
    ├─ CloudRuntime   → Oblien API: workspace.build() + execAndStream()
    ├─ BareRuntime    → executor.streamExec() through runBuildPipeline()
    └─ DockerRuntime  → (stub — Docker builds via Dockerfile)
```

## BuildLogger — Single Source of Truth

Every log emission goes through `BuildLogger`. No adapter creates `LogEntry` objects with step metadata directly.

```typescript
class BuildLogger {
  log(message: string, level?)       // Plain log line
  step(step, status, message)        // Step lifecycle event (stepper UI)
  runStep(step, label, fn)           // Run a step: emit running → execute → completed/failed
  get callback(): LogCallback        // Pass to exec functions for raw output streaming
}
```

### Who calls what

| Caller | Method | Purpose |
|---|---|---|
| `runBuildPipeline()` | `logger.runStep("clone", ...)` | Step events for clone/install/build |
| `runBuildPipeline()` | `logger.log(...)` | Pipeline status messages |
| `build.service.ts` | `logger.step("deploy", ...)` | Deploy phase step events |
| `build.service.ts` | `logger.log(...)` | Deploy status messages |
| `executor.streamExec()` | `logger.callback` (raw `LogCallback`) | stdout/stderr lines from shell commands |
| `cloud.ts execAndStream()` | raw `LogCallback` | Oblien exec output chunks |

## Shared Build Pipeline

`runBuildPipeline()` is used by `BareRuntime` and would be used by `DockerRuntime` when it supports builds. `CloudRuntime` has its own build flow via the Oblien API.

```
runBuildPipeline(env, config, logger)
    │
    ├─ Step: clone
    │    env.exec(`git clone --branch ${branch} --depth 1 ${repo} .`, logger.callback)
    │
    ├─ Step: install
    │    env.exec(`npm install` / `yarn` / `pnpm install`, logger.callback)
    │
    ├─ Step: build (if buildCommand configured)
    │    env.exec(buildCommand, logger.callback)
    │
    └─ Returns { status: "deploying" | "failed", durationMs }
```

The `BuildEnvironment` abstraction decouples the pipeline from the executor:

```typescript
interface BuildEnvironment {
  projectDir: string;
  exec(command: string, onLog: LogCallback): Promise<void>;
}
```

BareRuntime wires it to `this.executor.streamExec()`. A future Docker build could wire it to `docker exec`.

## Process Management (Bare Runtime)

### Deploy — setsid for proper process groups

```
deploy(config)
    │
    │  setsid nohup npm start >> logfile 2>&1 &
    │  echo $!
    │         │
    │         └─ PID captured → written to .pids/{deploymentId}.pid
    │
    └─ setsid makes npm the process group leader
       so all child processes belong to the same PGID
```

### Stop — kill the entire tree

```
stop(containerId)
    │
    │  1. Read PID from .pids/{containerId}.pid
    │  2. kill -- -${pid}        ← SIGTERM the entire process group
    │     (fallback: kill ${pid}   if group kill not supported)
    │  3. Wait up to 10s for graceful shutdown
    │  4. kill -9 -- -${pid}     ← SIGKILL the group if still alive
    │
    └─ This ensures child processes (e.g., node spawned by npm)
       are cleaned up too — no orphans
```

### PID Tracking

```
${workDir}/
  .pids/
    {deploymentId}.pid    ← contains the PID as plain text
  .logs/
    {deploymentId}.log    ← stdout + stderr from the process
```

All PID operations go through the executor:
- `readPid()` → `executor.readFile(pidFile)`
- `writePid()` → `executor.writeFile(pidFile, pid)`
- `isAlive()` → `executor.exec("kill -0 ${pid}")`

This means PID management works identically on local and remote (SSH) servers.

### Build Cancellation

```
cancelBuild(sessionId)
    │
    │  Read PID from .pids/build-{sessionId}.pid
    │  kill -- -${pid}   ← kill entire build process group
    │
    └─ Kills git clone, npm install, or whatever is running
```

## Resource Configuration

```typescript
interface ResourceConfig {
  cpuCores: number;   // Fractional cores (e.g., 0.5, 1, 2)
  memoryMb: number;   // Memory in megabytes
}

// Defaults
DEFAULT_RESOURCE_CONFIG  = { cpuCores: 0.5, memoryMb: 512 }   // runtime
DEFAULT_BUILD_RESOURCE_CONFIG = { cpuCores: 2, memoryMb: 4096 } // build
```

- Cloud: `cpuCores` passed directly to Oblien SDK (fractional, e.g., 0.5)
- Docker: used for container resource limits
- Bare: informational only (OS manages resources)

## Error Handling

Build failures cascade cleanly:

```
Pipeline step fails (e.g., npm install exits non-zero)
    │
    ├─ executor.streamExec returns { code: non-zero }
    ├─ BuildEnvironment.exec throws Error
    ├─ runBuildPipeline catches → logger.step(step, "failed", message)
    ├─ Returns { status: "failed" }
    │
    ▼
build.service.ts
    ├─ Updates deployment status to "failed"
    ├─ Persists logs to DB via finishBuildSession()
    ├─ Broadcasts failure via SSE
    └─ Sends failure notification email
```
