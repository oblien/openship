# Log Streaming — From Adapter to Terminal

> How log data flows from command execution to the user's browser terminal.

## Two Streaming Paths

| Path | When | Encoding |
|---|---|---|
| **Live SSE** | Build/deploy in progress | base64 over SSE |
| **Status API** | Historical / page load | Plain text in JSON response |

## Live Streaming Flow

```
Adapter exec output
    │
    │  Cloud:  Oblien returns native base64 chunks
    │  Bare:   executor.streamExec returns plain text lines
    │  Docker: container.logs() returns plain text lines
    │
    ▼
LogEntry { message: string, rawData?: string }
    │
    │  Cloud entries:  rawData = native base64 from Oblien
    │                  message = decoded text (for DB / display)
    │  Bare/Docker:    message = plain text
    │                  rawData = undefined
    │
    ▼
logCallback(entry)  [build.service.ts]
    │
    ├─ logs.push(entry)              ← accumulate for DB persistence
    │
    └─ sessionManager.appendLog(id, entry)
         │
         ├─ session.logs.push(entry) ← in-memory for replay
         │
         └─ broadcast to SSE subscribers
              │
              ▼
         formatLogPayload(entry, eventId)
              │
              │  Single handover point for encoding:
              │  base64Data = entry.rawData ?? Buffer.from(entry.message).toString("base64")
              │
              │  Cloud:     rawData exists → pass through (zero encoding work)
              │  Bare/Docker: rawData undefined → encode plain text to base64
              │
              ▼
         SSE event: { type: "log", data: base64, eventId, step?, stepStatus?, level }
              │
              ▼
         Browser: EventSource receives SSE
              │
              ▼
         useSSEStream.ts processLogData()
              │
              │  atob(data) → Uint8Array → TextDecoder → text
              │  Write bytes to xterm.js terminal
              │
              ▼
         Terminal renders output
```

## Historical Replay Flow

```
Frontend loads deployment page
    │
    ▼
GET /api/deployments/:id/build-status
    │
    ▼
build.service.ts getBuildSessionStatus()
    │
    ├─ Check DB: findBuildSessionByDeploymentId()
    ├─ Check memory: sessionManager.getSession()
    │
    │  logEntries = dbRow.logs ?? memSession.logs ?? []
    │  logsText = logEntries.map(l => l.message).join("\n")
    │
    ▼
Response: { logs: logsText, status, ... }
    │
    ▼
Frontend: useDeploymentBuild.ts loadBuildSession()
    │
    │  data.logs.split("\n")
    │    .filter(line => line.trim())
    │    .map(line => ({ type: "info", text: line }))
    │    .forEach(log => writeToTerminal(encode(log.text + "\r\n")))
    │
    ▼
Terminal renders historical output
```

## Why Base64 for SSE?

Build output contains binary-unfriendly characters (ANSI color codes, progress bars, carriage returns). Base64 ensures safe transport over SSE text frames without escaping issues.

## Step Events

Step events use the same `LogEntry` transport but with extra fields:

```typescript
{
  timestamp: "2026-03-11T...",
  message: "Installing dependencies (npm)",   // human-readable
  level: "info",
  step: "install",                             // which pipeline step
  stepStatus: "running"                        // running | completed | failed | skipped
}
```

The frontend stepper UI reads `step` + `stepStatus` from SSE messages to update the progress indicator. The `message` text is logged to the terminal simultaneously.

## DB Persistence

When a build finishes (success or failure):

```
finishBuildSession(sessionId, status, durationMs, logs: LogEntry[])
    │
    └─ UPDATE build_sessions SET
         status = 'ready' | 'failed',
         duration_ms = ...,
         logs = JSON(LogEntry[])    ← full array serialized as JSON
```

The `logs` column stores the complete `LogEntry[]` array. On historical load, `message` fields are joined into plain text. `rawData` fields are not persisted — they're only used during live SSE transport.

## Adapter-Specific Details

### Cloud (Oblien)

```
Oblien exec.stream(cmd) → AsyncGenerator<ExecStreamEvent>
    │
    │  event.event = "stdout" → event.data is base64
    │  event.event = "stderr" → event.data is base64
    │  event.event = "exit"   → event.exit_code
    │  event.event = "output" → event.stdout/stderr are base64
    │
    ▼
execAndStream() emit():
    message = Buffer.from(b64, "base64").toString("utf-8").trimEnd()
    rawData = b64   ← native, no re-encoding needed
```

### Bare (Executor)

```
executor.streamExec("npm install", onLog)
    │
    │  spawn("sh", ["-c", command], { detached: true })
    │  stdout.on("data") → split by \n → logEntry(line)
    │  stderr.on("data") → split by \n → logEntry(line, "warn")
    │
    ▼
logEntry():
    { timestamp, message: plainText, level }
    // No rawData — session-manager encodes at handover point
```

### Docker

```
container.logs({ follow: true }) → ReadableStream
    │
    │  Buffer chunks → split by \n → parse Docker timestamp prefix
    │  { timestamp: dockerTimestamp, message: rest, level: parseLevel(rest) }
    │
    ▼
Same as bare — plain text, no rawData
```
