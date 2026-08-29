"use client";

/**
 * useSystemPrepareModal — ONE reusable driver for any "prepare the system, with
 * consent" flow that streams over SSE and may block on a prompt: a `session`
 * event (id to answer with), `log` lines, a generic `prompt` (rendered by the
 * shared `PromptDetails` — the SAME contract the deploy pipeline + server-setup
 * use), and a terminal `complete`. It opens through the app's global
 * `ModalContext`, so callers never mount a `<Modal>` or re-import a component —
 * they just pass a stream + respond URL.
 *
 * `useEdgeModal` below is the first consumer (port-80/443 edge takeover); future
 * flows (component installs, port handovers, …) reuse `useSystemPrepareModal`
 * with their own endpoints.
 *
 *   const prepare = useSystemPrepareModal();
 *   prepare({ streamUrl, respondUrl, title, onDone });
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck, Copy, RefreshCw } from "lucide-react";
import { useModal } from "@/context/ModalContext";
import { PromptDetails } from "@/components/import-project/PromptDetails";
import { InstallStepper } from "@/components/deploy/InstallStepper";
import { getApiBaseUrl, domainsApi, projectsApi, systemApi } from "@/lib/api";
import { canReportStreamEnd, reportLostStream } from "./prepare-stream-outcome";

interface StreamPrompt {
  promptId: string;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
}

/** A coarse step of a streamed operation, driving the optional progress bar. A
 *  flow that never emits `steps` (verify, edge takeover) simply never shows it. */
interface StreamStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
}

/** Percentage bar + per-step checklist, shown only when the stream emits steps.
 *  The checklist is the shared `InstallStepper` (StreamStep's status union is a
 *  subset of its `StepStatus`); the progress bar is this flow's own chrome. */
function StepProgress({ steps }: { steps: StreamStep[] }) {
  const done = steps.filter((s) => s.status === "done").length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <InstallStepper steps={steps} />
    </div>
  );
}

type Phase = "running" | "completed" | "failed" | "error";

export interface SystemPrepareOptions {
  /** POST SSE endpoint (relative to the API base) that runs the flow. */
  streamUrl: string;
  /** JSON body for the stream POST. The takeover/verify flows carry their target
   *  in the URL and need none; the shared install endpoint takes it in the body
   *  (`{ serverId, components }`), so it's optional and defaults to `{}`. */
  body?: Record<string, unknown>;
  /** POST endpoint answered with `{ sessionId, action }` for a prompt. Omit for
   *  flows that never prompt (e.g. verify) — the modal is pure log + result. */
  respondUrl?: string;
  /** Modal heading. */
  title?: string;
  /** Copy overrides for the non-prompt phases. */
  labels?: { working?: string; done?: string; failed?: string; close?: string };
  /** Fired once on successful completion. */
  onDone?: () => void;
  /**
   * Last-resort outcome read, for a stream that died WITHOUT a terminal event
   * (server closed early / connection dropped mid-run). The operation's real
   * result is usually still recorded server-side, so ask instead of telling the
   * user to "go check" — that's a dead end they can't act on. Returning null
   * means "still couldn't tell", which keeps the honest unknown message.
   */
  resolveOutcome?: () => Promise<{ ok: boolean; message: string } | null>;
  /**
   * Read-only GET SSE endpoint for an ALREADY-running session, built from its
   * id. Presence enables two re-attach paths: (1) mount re-attach, when the
   * caller passes `initialAttachSessionId`; (2) a POST that 409s with a
   * `sessionId` (a run is already in flight) re-attaches instead of surfacing
   * the raw code. A mount re-attach NEVER POSTs — a POST could start a fresh run
   * if the session finished in the detect→open window.
   */
  attachUrl?: (sessionId: string) => string;
  /** Open straight into GET re-attach for this session (browser-refresh path). */
  initialAttachSessionId?: string;
}

/**
 * Humanize the machine error codes the prepare endpoints return so a raw
 * `install_in_progress` never lands in the modal. Unmapped codes fall back to
 * the server's own message (or statusText).
 */
const FRIENDLY_ERRORS: Record<string, string> = {
  // Defensive only: the effect re-attaches on a 409 rather than surfacing this,
  // but if the re-attach can't resolve a session id we still want readable copy.
  install_in_progress: "An install is already running — reattaching to it…",
  auth_failed: "The server rejected the connection — check its SSH credentials and try again.",
  no_server: "That server no longer exists.",
  "No active session": "That run has already finished.",
};

function friendlyError(code: string | undefined, fallback: string): string {
  return (code && FRIENDLY_ERRORS[code]) || fallback;
}

/** Modal body — rendered as the global modal's `customContent`. */
function PrepareStreamContent({
  opts,
  onClose,
}: {
  opts: SystemPrepareOptions;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<Array<{ message: string; level: string }>>([]);
  const [steps, setSteps] = useState<StreamStep[]>([]);
  const [prompt, setPrompt] = useState<StreamPrompt | null>(null);
  const [phase, setPhase] = useState<Phase>("running");
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Retry — re-runs the stream effect in place. */
  const [attempt, setAttempt] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  /**
   * When set (mount re-attach via `initialAttachSessionId`, or a 409 handing
   * back the running session's id), the effect GETs the read-only attach stream
   * instead of POSTing a fresh run. Retry clears it so "Try again" always POSTs.
   */
  const attachSessionIdRef = useRef<string | null>(opts.initialAttachSessionId ?? null);
  /**
   * A terminal `complete` was received, so the outcome is KNOWN. Everything
   * after it — the reader ending, a late socket error — is teardown noise and
   * must never overwrite the result (it used to, turning a finished operation
   * into a generic failure and hiding the log with it).
   */
  const terminalRef = useRef(false);

  const respond = useCallback(
    async (action: string) => {
      setPrompt(null);
      const sid = sessionIdRef.current;
      if (!sid || !opts.respondUrl) return;
      try {
        await fetch(`${getApiBaseUrl()}${opts.respondUrl}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, action }),
        });
      } catch {
        /* the stream reports the outcome */
      }
    },
    [opts.respondUrl],
  );

  /**
   * The stream died before saying how it went. Ask the server what actually
   * happened; only fall back to "unknown" when even that can't answer. Either
   * way the log stays on screen — it's the only record of the run.
   */
  const reportUnknownOutcome = useCallback(async () => {
    const outcome = (await opts.resolveOutcome?.().catch(() => null)) ?? null;
    terminalRef.current = true;
    const report = reportLostStream(outcome);
    setPhase(report.phase);
    if (report.logLine) setLogs((p) => [...p, { message: report.logLine!, level: "info" }]);
    if (report.error) setError(report.error);
    if (report.phase === "completed") opts.onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.resolveOutcome, opts.onDone]);

  const retry = useCallback(() => {
    setLogs([]);
    setSteps([]);
    setError(null);
    setPrompt(null);
    setPhase("running");
    // "Try again" is an explicit re-run: drop any re-attach id so the effect
    // POSTs fresh (install 409→re-attaches if still running; else a new run).
    attachSessionIdRef.current = null;
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    // NO "started" ref-guard here: combined with the abort-on-cleanup below it
    // deadlocks under React StrictMode (dev) — the first run's fetch is aborted
    // by the immediate cleanup, then the second run is skipped by the guard, so
    // NO fetch ever resolves and the modal hangs on "Connecting…" (never even
    // showing a 404). The AbortController alone is StrictMode-safe: the first
    // run aborts, the second run fetches fresh.
    const controller = new AbortController();
    terminalRef.current = false;

    // Read + dispatch the SSE frames off a streaming Response. Shared verbatim by
    // the POST (fresh run) and GET (re-attach) paths so both parse identically
    // (session / steps / log / prompt / complete + the terminal guard).
    const consume = async (res: Response) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let json: {
            type?: string;
            sessionId?: string;
            message?: string;
            level?: string;
            status?: Phase;
            steps?: StreamStep[];
          } & Partial<StreamPrompt>;
          try {
            json = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (json.type === "session" && json.sessionId) sessionIdRef.current = json.sessionId;
          else if (json.type === "steps") setSteps(json.steps ?? []);
          else if (json.type === "log")
            setLogs((p) => [...p, { message: json.message ?? "", level: json.level ?? "info" }]);
          else if (json.type === "prompt") setPrompt(json as StreamPrompt);
          else if (json.type === "complete") {
            terminalRef.current = true;
            const ok = json.status === "completed";
            setPhase(ok ? "completed" : "failed");
            setPrompt(null);
            if (ok) opts.onDone?.();
          }
        }
      }
    };

    const attachStream = (sid: string) =>
      fetch(`${getApiBaseUrl()}${opts.attachUrl!(sid)}`, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

    (async () => {
      try {
        const attachSid = attachSessionIdRef.current;
        let res: Response;
        if (attachSid && opts.attachUrl) {
          // Mount / browser-refresh re-attach: read-only GET, NEVER a POST — a
          // POST here could start a brand-new run if the session finished in the
          // detect→open window.
          sessionIdRef.current = attachSid;
          res = await attachStream(attachSid);
        } else {
          res = await fetch(`${getApiBaseUrl()}${opts.streamUrl}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify(opts.body ?? {}),
            signal: controller.signal,
          });
          // An install POST 409s when one is already running, handing back its
          // session id — re-attach to that live run instead of showing the raw
          // `install_in_progress`. (Only install 409s; container-apply re-POST is
          // idempotent, so this branch is simply never taken there.)
          if (res.status === 409 && opts.attachUrl) {
            let sid: string | undefined;
            try {
              sid = (await res.json())?.sessionId;
            } catch {
              /* fall through to the generic !res.ok handling below */
            }
            if (sid) {
              attachSessionIdRef.current = sid;
              sessionIdRef.current = sid;
              res = await attachStream(sid);
            }
          }
        }

        if (!res.ok || !res.body) {
          let code: string | undefined;
          let msg = res.statusText;
          try {
            const j = await res.json();
            code = j.error;
            msg = j.error || j.message || msg;
          } catch {
            /* keep statusText */
          }
          setError(friendlyError(code, msg));
          setPhase("error");
          return;
        }

        await consume(res);
        // Stream ended WITHOUT a terminal `complete` (server closed early /
        // crashed / the connection dropped mid-op). The operation's outcome is
        // usually still recorded server-side, so read it back rather than
        // telling the user to go and check for themselves.
        if (canReportStreamEnd(terminalRef.current)) await reportUnknownOutcome();
      } catch (e) {
        // A late failure AFTER the outcome is known is teardown noise — the
        // server already told us how it went, and overwriting that with a
        // network message would replace a real result with a lie.
        if ((e as { name?: string })?.name !== "AbortError" && canReportStreamEnd(terminalRef.current)) {
          setLogs((p) => [
            ...p,
            { message: e instanceof Error ? e.message : String(e), level: "error" },
          ]);
          await reportUnknownOutcome();
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.streamUrl, attempt]);

  const l = opts.labels ?? {};
  // Deep enough to hold a whole certbot run — the tail used to be 12 lines,
  // which cut off the part of the failure that names the cause.
  const tail = logs.slice(-400);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  // Keep the newest line in view as the stream flows.
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(logs.map((entry) => entry.message).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — nothing useful to say */
    }
  };

  /**
   * The run's console. Rendered in EVERY non-prompt phase, not just while
   * running: on a failure this log IS the answer (certbot's real reason lives
   * here), and swapping it for a one-line banner threw away the only diagnosis
   * the operator had.
   */
  const logConsole = (
    <div className="space-y-1.5">
      <div
        ref={logBoxRef}
        className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-border/50 bg-muted/20 p-3 font-mono text-[11px] text-muted-foreground"
      >
        {tail.length > 0 ? (
          tail.map((entry, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words ${entry.level === "error" ? "text-danger" : entry.level === "warn" ? "text-warning" : ""}`}
            >
              {entry.message}
            </div>
          ))
        ) : (
          <div className="italic opacity-70">{phase === "running" ? "Connecting…" : "No output."}</div>
        )}
      </div>
      {logs.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void copyLog()}
            className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Copy className="size-3" />
            {copied ? "Copied" : "Copy log"}
          </button>
        </div>
      )}
    </div>
  );

  /** The step checklist, when the flow emits one; null for step-less flows. */
  const stepBar = steps.length > 0 ? <StepProgress steps={steps} /> : null;

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-2.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20">
          <ShieldCheck className="size-[18px] text-primary" />
        </div>
        <h2 className="text-base font-semibold text-foreground">{opts.title ?? "Prepare"}</h2>
      </div>

      {prompt ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">{prompt.title}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{prompt.message}</p>
          <PromptDetails details={prompt.details} />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {prompt.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => respond(a.id)}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  a.variant === "primary"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : a.variant === "danger"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : "border border-border text-foreground hover:bg-muted"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ) : phase === "completed" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-success-bg px-4 py-3 text-sm text-success">
            <CheckCircle2 className="size-5 shrink-0" />
            <span className="font-medium">{l.done ?? "Done."}</span>
          </div>
          {stepBar}
          {logConsole}
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
              {l.close ?? "Done"}
            </button>
          </div>
        </div>
      ) : phase === "failed" || phase === "error" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="whitespace-pre-wrap">
              {error || l.failed || "Couldn't finish — nothing was disrupted."}
            </span>
          </div>
          {stepBar}
          {logConsole}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <RefreshCw className="size-3.5" />
              Try again
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
              {l.close ?? "Close"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{l.working ?? "Working…"}</span>
          </div>
          {stepBar}
          {logConsole}
        </div>
      )}
    </div>
  );
}

/** Generic: returns `prepare(opts)` — opens the consent/prepare flow in the
 *  global modal and returns the modal id. */
export function useSystemPrepareModal() {
  const { showModal, hideModal } = useModal();
  return useCallback(
    (opts: SystemPrepareOptions): string => {
      let id = "";
      id = showModal({
        width: "560px",
        maxWidth: "95vw",
        showCloseButton: true,
        customContent: <PrepareStreamContent opts={opts} onClose={() => hideModal(id)} />,
      });
      return id;
    },
    [showModal, hideModal],
  );
}

/** Self-hosted domain verify with LIVE certbot logs — streams the standalone
 *  HTTP-01 run. No prompt (verify never asks for consent), so no respondUrl.
 *  `openVerifyModal(domainId, { hostname, onDone })`. */
export function useVerifyModal() {
  const prepare = useSystemPrepareModal();
  return useCallback(
    (domainId: string, opts?: { hostname?: string; onDone?: () => void }): string =>
      prepare({
        streamUrl: `domains/${domainId}/verify/stream`,
        title: opts?.hostname ? `Verify ${opts.hostname}` : "Verify domain",
        labels: {
          working: "Verifying — issuing the certificate…",
          done: "Verified — certificate issued and SSL active.",
          failed: "Couldn't verify — see the log above for the exact reason.",
        },
        onDone: opts?.onDone,
        // A dropped stream doesn't mean a dropped verify: certbot may well have
        // finished and the row already say so. Read it instead of handing the
        // operator a "check the domain's status" they can't act on.
        resolveOutcome: async () => {
          const domain = (await domainsApi.get(domainId)).data;
          if (domain.verified) {
            return {
              ok: true,
              message: `${domain.hostname} is verified (SSL ${domain.sslStatus ?? "unknown"}) — the connection dropped after the run finished.`,
            };
          }
          return {
            ok: false,
            message:
              domain.lastVerifyError ??
              `${domain.hostname} is still unverified. The connection dropped before this run reported a result — the log above is what it got through.`,
          };
        },
      }),
    [prepare],
  );
}

/** Managed-container converge (edge / mail) on one server — streams the
 *  rollback-guarded pull→recreate→verify with a step bar. Never prompts (neither
 *  intent asks for consent), so no respondUrl. Both this manual click and a
 *  boot-time auto-update attach to the SAME replayable server-side session, so
 *  re-opening mid-run resumes the live progress rather than starting a second run.
 *
 *  `intent: "repair"` starts a STOPPED container instead of swapping its image —
 *  the recovery path for a mail engine, whose update is swap-only by design.
 *  `openContainerModal(serverId, "edge", { label, intent, onDone })`. */
export function useContainerApplyModal() {
  const prepare = useSystemPrepareModal();
  return useCallback(
    (
      serverId: string,
      component: "edge" | "mail",
      opts?: {
        label?: string;
        intent?: "update" | "repair";
        onDone?: () => void;
        /** Open straight into GET re-attach for this running swap (refresh path). */
        attachSessionId?: string;
      },
    ): string => {
      const noun = opts?.label ?? (component === "edge" ? "edge" : "mail engine");
      const repair = opts?.intent === "repair";
      // A dropped stream doesn't mean a dropped run — the container may already be
      // running (new image, or simply started) and the row already say so. Read it
      // back rather than reporting an unknown outcome for a run that finished.
      const resolveOutcome = async () => {
        const list = await systemApi.listServerContainers(serverId).catch(() => null);
        const row = list?.find((r) => r.component === component) ?? null;
        if (repair) {
          if (row && !row.detail?.down) {
            return {
              ok: true,
              message: `The ${noun} is running again (${row.runningLabel ?? row.runningVersion ?? "current"}) — the connection dropped after the run finished.`,
            };
          }
          return {
            ok: false,
            message: `The ${noun} is still stopped — ${row?.detail?.lastError ?? "the log above is what the run got through"}.`,
          };
        }
        if (row && !row.behind && !row.detail?.down) {
          return {
            ok: true,
            message: `The ${noun} is up to date (${row.runningLabel ?? row.runningVersion ?? "current"}) — the connection dropped after the run finished.`,
          };
        }
        if (row?.detail?.down) {
          return {
            ok: false,
            message: `The ${noun} is down after the update — ${row.detail.lastError ?? "see the log above"}.`,
          };
        }
        return {
          ok: false,
          message: `The ${noun} is still behind (running ${row?.runningVersion ?? "?"}, target ${row?.pinnedVersion ?? "?"}). The log above is what the run got through.`,
        };
      };

      return prepare({
        streamUrl: `system/servers/${serverId}/containers/${component}/apply/stream${repair ? "?intent=repair" : ""}`,
        // The read-only GET sibling of the apply stream re-attaches to the one
        // running swap for this (server, component); it ignores the id (there's
        // only ever one), which is why re-POST is idempotent and never 409s.
        attachUrl: () => `system/servers/${serverId}/containers/${component}/apply/stream`,
        initialAttachSessionId: opts?.attachSessionId,
        title: repair ? `Start ${noun}` : `Update ${noun}`,
        labels: repair
          ? {
              working: `Starting the ${noun}…`,
              done: `Started — the ${noun} is running again.`,
              failed: `The ${noun} didn't start — see the log above for the exact reason.`,
            }
          : {
              working: `Updating the ${noun}…`,
              done: `Updated — the ${noun} is running the new version.`,
              failed: `Update didn't finish — the ${noun} was rolled back to its previous version. See the log above.`,
            },
        onDone: opts?.onDone,
        resolveOutcome,
      });
    },
    [prepare],
  );
}

/** One-click edge install/fix for a server — reuses the FIRST-INSTALL engine
 *  (`/system/install/stream` + `/install/respond`) verbatim, so a missing edge
 *  installs and a down edge is recreated through the SAME 80/443-takeover
 *  consent path a fresh server setup takes (`startEdgeContainer` does `docker rm
 *  -f` first, so a stopped leftover is replaced cleanly). Body carries the
 *  target `{ serverId, components:["edge"] }` — the endpoint is shared, unlike
 *  the URL-scoped takeover/apply flows. `openEdgeInstallModal(serverId, { onDone })`. */
export function useServerEdgeInstallModal() {
  const prepare = useSystemPrepareModal();
  return useCallback(
    (
      serverId: string,
      opts?: {
        onDone?: () => void;
        /** Open straight into GET re-attach for this running install (refresh path). */
        attachSessionId?: string;
      },
    ): string =>
      prepare({
        streamUrl: "system/install/stream",
        respondUrl: "system/install/respond",
        // GET re-attach to a running install by id: replays logs + progress AND
        // any parked 80/443-takeover prompt (answered via respondUrl above). Also
        // the target of the 409→attach path when a second install POST is made.
        attachUrl: (sid) => `system/install/stream?id=${encodeURIComponent(sid)}`,
        initialAttachSessionId: opts?.attachSessionId,
        body: { serverId, components: ["edge"] },
        title: "Install edge",
        labels: {
          working: "Installing the edge — taking over ports 80/443 if needed…",
          done: "Edge installed — it owns ports 80/443 and routes are live.",
          failed: "Edge install didn't finish — nothing else was disrupted. See the log above.",
        },
        onDone: opts?.onDone,
        // The install path is takeover-heavy and can outlive its connection; read
        // the edge row back rather than reporting an unknown outcome for an
        // install that actually finished. Present && not down == success.
        resolveOutcome: async () => {
          const list = await systemApi.listServerContainers(serverId).catch(() => null);
          const edge = list?.find((r) => r.component === "edge") ?? null;
          if (edge && !edge.detail?.down) {
            return {
              ok: true,
              message: `The edge is installed and running (${edge.runningLabel ?? edge.runningVersion ?? "current"}) — the connection dropped after the run finished.`,
            };
          }
          if (edge?.detail?.down) {
            return {
              ok: false,
              message: `The edge is installed but down — ${edge.detail.lastError ?? "see the log above"}.`,
            };
          }
          return {
            ok: false,
            message:
              "The edge isn't installed yet. The connection dropped before this run reported a result — the log above is what it got through.",
          };
        },
      }),
    [prepare],
  );
}

/** Port-80/443 edge takeover — the first `useSystemPrepareModal` consumer.
 *  `openEdgeModal(projectId, { onDone })`. */
export function useEdgeModal() {
  const prepare = useSystemPrepareModal();
  return useCallback(
    (projectId: string, opts?: { onDone?: () => void }): string =>
      prepare({
        streamUrl: `projects/${projectId}/routing/ensure-edge/stream`,
        respondUrl: `projects/${projectId}/routing/ensure-edge/respond`,
        title: "Set up edge routing",
        labels: {
          working: "Preparing the server's edge…",
          done: "Edge ready — your routes are live.",
          failed: "Edge setup didn't finish — the app stays on its port; routing is flagged on this tab.",
        },
        onDone: opts?.onDone,
        // Edge setup installs OpenResty and can take a takeover path, so it's the
        // flow most likely to outlive its own connection. The result is readable
        // from the server afterwards — ask, the way the verify modal does, rather
        // than reporting an unknown outcome for an install that finished.
        resolveOutcome: async () => {
          const status = await projectsApi.getEdgeStatus(projectId);
          if (status.ready) {
            return {
              ok: true,
              message: "The server's edge is set up and owns ports 80/443 — the connection dropped after the run finished.",
            };
          }
          return {
            ok: false,
            message:
              status.reason ??
              (status.reachable === false
                ? "The server isn't reachable, so the edge couldn't be checked. The log above is what the run got through."
                : `The edge is not set up yet${status.classification ? ` (ports 80/443: ${status.classification})` : ""}. The log above is what the run got through.`),
          };
        },
      }),
    [prepare],
  );
}
