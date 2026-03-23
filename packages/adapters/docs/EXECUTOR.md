# Command Executor — Local & SSH Abstraction

> The single abstraction that makes the entire platform work on both local and remote servers.

## The Problem

Openship needs to:
- Run shell commands (git, npm, kill, systemctl)
- Read/write files (PID files, Traefik YAML configs, log files)
- Check if files exist (`.git` dirs, ACME storage)

Sometimes on the **same machine** (self-hosted, single-server). Sometimes on a **remote server** via SSH (multi-server, managed hosting).

Without an abstraction, every function would need two code paths.

## The Solution

```typescript
interface CommandExecutor {
  exec(command: string, opts?: { timeout?: number }): Promise<string>;
  streamExec(command: string, onLog: (log: LogEntry) => void): Promise<{ code: number; output: string }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  dispose(): Promise<void>;
}
```

Two implementations, same interface:

| Method | `LocalExecutor` | `SshExecutor` |
|---|---|---|
| `exec()` | `child_process.exec()` | `ssh2.Client.exec()` |
| `streamExec()` | `child_process.spawn()` detached (process group leader) | `ssh2.Client.exec()` with stream events |
| `writeFile()` | `fs.writeFile()` | SFTP `writeFile()` |
| `readFile()` | `fs.readFile()` | SFTP `readFile()` |
| `exists()` | `fs.access()` | SFTP `stat()` |
| `mkdir()` | `fs.mkdir({ recursive })` | `ssh exec("mkdir -p")` |
| `rm()` | `fs.rm()` | SFTP `unlink()` |
| `dispose()` | no-op | `client.end()` |

## Who Uses It

```
CommandExecutor (single instance in selfhosted mode)
    │
    ├── BareRuntime
    │     build()    → git clone, npm install, npm build (streamExec)
    │     deploy()   → nohup npm start & echo $! (exec)
    │     stop()     → kill PID (exec)
    │     isAlive()  → kill -0 PID (exec)
    │     logs       → tail -n (exec) or readFile
    │     PID mgmt   → readFile / writeFile / rm
    │
    ├── TraefikProvider
    │     registerRoute() → writeFile (YAML config)
    │     removeRoute()   → rm (config file)
    │     provisionCert() → readFile (ACME storage JSON)
    │
    ├── SystemManager (via checks + installers)
    │     checks    → exec("docker --version"), exec("node -v"), etc.
    │     installs  → streamExec("curl ... | sh"), streamExec("apt install")
    │
    └── FileStateStore
          get()  → readFile (state JSON)
          set()  → writeFile (state JSON)
```

## Security

### SSH: Key-Based Auth Only
```typescript
// Password auth is deliberately not supported
if (!config.privateKey && !config.sshAgent) {
  throw new Error("SSH requires either privateKey or sshAgent");
}
```

### No User Input in Shell Strings
- `InstallerConfig` values (email, domain) are validated before use
- Shell commands use hardcoded arguments
- `DEBIAN_FRONTEND=noninteractive` is always set

### Connection Lifecycle
- SSH connection is established **lazily** on first use
- Reused for all subsequent operations (no reconnect overhead)
- `dispose()` must be called on shutdown to close the connection

## Real-Time Log Streaming

Both executors support `streamExec()` — the key to showing live install/build progress:

```typescript
// stdout lines → onLog({ level: "info", message: line })
// stderr lines → onLog({ level: "warn", message: line })
// returns { code, output } when command exits
```

This powers:
- Build progress in the dashboard (git output, npm install progress)
- System setup wizard (live installation output)
- Any command that needs to show output as it happens

## Factory

```typescript
import { createExecutor } from "@repo/adapters";

// Local — commands run on this machine
const local = createExecutor();

// Remote — commands run on the SSH server
const remote = createExecutor({
  host: "192.168.1.100",
  username: "deploy",
  privateKey: decryptedKey,
});
```

The platform does this automatically — you don't call `createExecutor()` directly in service code. It's wired through `PlatformConfig.ssh`.

## Important: Docker is Different

`DockerRuntime` does **NOT** use `CommandExecutor`. It uses dockerode as the Docker control plane and, for SSH targets, tunnels directly to the remote Docker socket:

```typescript
// DockerRuntime connects to Docker Engine directly
new Dockerode({ socketPath: "/var/run/docker.sock" })
// or over a socket-like SSH tunnel to the remote Docker socket
```

This is correct because:
- Docker Engine API is a separate protocol (HTTP over socket/SSH/TCP)
- dockerode handles multiplexing, streaming, and image pulls natively
- Wrapping Docker commands in `executor.exec("docker ...")` would lose all that

The shared executor handles everything **except** Docker container management:
- Traefik config files (YAML writes)
- System checks and installations
- Bare runtime process management (when not using Docker)

## Process Groups & Cleanup

### LocalExecutor — detached spawn

`streamExec()` uses `spawn("sh", ["-c", command], { detached: true })`. The `detached: true` flag makes the child process a **process group leader**. This means:

- The child and all its descendants share the same PGID
- `kill -- -${pid}` kills the entire tree in one shot
- No orphan processes when a build is cancelled

### BareRuntime — setsid for deployed processes

Deploy uses `setsid nohup npm start &` — `setsid` creates a new session and process group. The stored PID equals the PGID, so:

```
kill -- -${pid}        ← SIGTERM entire group (npm + node + children)
kill -9 -- -${pid}     ← SIGKILL entire group (fallback after 10s)
```

Fallback to plain `kill ${pid}` if group kill isn't supported (some minimal environments).

### Why not just `kill ${pid}`?

```
npm start
  └─ node server.js
       └─ worker.js

kill ${pid}       ← only kills npm, node+worker become orphans
kill -- -${pid}   ← kills npm, node, AND worker — clean shutdown
```

