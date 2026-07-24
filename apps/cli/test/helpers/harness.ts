/**
 * Shared test harness for the CLI suite.
 *
 * Three isolation seams, matching how the CLI actually reaches the outside world:
 *   - captureStdio  — collect what a command writes to stdout/stderr (ANSI stripped).
 *   - stubFetch     — route the CLI's HTTP calls to an in-test handler, no network.
 *   - interceptExit — turn process.exit(code) into a thrown ExitError so a guard's
 *                     `process.exit(1)` becomes an assertable outcome, not a killed runner.
 *
 * Command modules build their request through the real api-client (URL building,
 * header/auth, ApiError mapping all run for real); only `fetch` and the config/caps
 * seams are mocked, so these are end-to-end minus the socket.
 */
import { vi } from "vitest";

// ─── stdout / stderr capture ─────────────────────────────────────────────────

const ANSI = /\[[0-9;]*m/g;

export interface Captured {
  /** Everything written to stdout, ANSI stripped. */
  out: () => string;
  /** Everything written to stderr, ANSI stripped. */
  err: () => string;
  restore: () => void;
}

export function captureStdio(): Captured {
  let out = "";
  let errOut = "";
  const so = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    errOut += String(chunk);
    return true;
  });
  return {
    out: () => out.replace(ANSI, ""),
    err: () => errOut.replace(ANSI, ""),
    restore: () => {
      so.mockRestore();
      se.mockRestore();
    },
  };
}

// ─── fetch stubbing ──────────────────────────────────────────────────────────

export interface StubResponse {
  status?: number;
  /** JSON body (serialized for the response). */
  json?: unknown;
  /** Raw text body; takes precedence over `json`. */
  text?: string;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FetchStub {
  /** Requests the CLI made, in order. */
  calls: RecordedRequest[];
  restore: () => void;
}

/**
 * Stub global fetch. `handler` receives the parsed request and returns a
 * StubResponse (or a Response directly, for stream bodies). Records every call.
 */
export function stubFetch(
  handler: (req: RecordedRequest) => StubResponse | Response | Promise<StubResponse | Response>,
): FetchStub {
  const calls: RecordedRequest[] = [];
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedRequest = { url, method, body, headers };
    calls.push(req);

    const r = await handler(req);
    if (r instanceof Response) return r;
    const status = r.status ?? 200;
    const payload = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return new Response(status === 204 ? null : payload, {
      status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { calls, restore: () => vi.unstubAllGlobals() };
}

// ─── process.exit interception ───────────────────────────────────────────────

export class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
  }
}

export function interceptExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
}

/**
 * Run a commander Command's action to completion, capturing output and any
 * `process.exit`. Returns the captured streams plus the exit code (0 if the
 * action returned normally). `argv` is the user-facing args after the command
 * name, e.g. ["list", "--json"].
 */
export async function runCommand(
  command: { parseAsync: (argv: string[], opts?: { from: "user" }) => Promise<unknown> },
  argv: string[],
): Promise<{ out: string; err: string; code: number }> {
  const cap = captureStdio();
  const exit = interceptExit();
  const prevExitCode = process.exitCode;
  process.exitCode = 0;
  let code = 0;
  try {
    await command.parseAsync(argv, { from: "user" });
    // Some actions signal failure via process.exitCode instead of exit().
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof ExitError) code = e.code;
    else {
      process.exitCode = prevExitCode;
      cap.restore();
      exit.mockRestore();
      throw e;
    }
  }
  const result = { out: cap.out(), err: cap.err(), code };
  process.exitCode = prevExitCode;
  cap.restore();
  exit.mockRestore();
  return result;
}
