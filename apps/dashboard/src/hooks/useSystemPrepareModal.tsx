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
import { getApiBaseUrl, domainsApi } from "@/lib/api";
import { canReportStreamEnd, reportLostStream } from "./prepare-stream-outcome";

interface StreamPrompt {
  promptId: string;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
}

type Phase = "running" | "completed" | "failed" | "error";

export interface SystemPrepareOptions {
  /** POST SSE endpoint (relative to the API base) that runs the flow. */
  streamUrl: string;
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
  const [prompt, setPrompt] = useState<StreamPrompt | null>(null);
  const [phase, setPhase] = useState<Phase>("running");
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Retry — re-runs the stream effect in place. */
  const [attempt, setAttempt] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
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
    setError(null);
    setPrompt(null);
    setPhase("running");
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
    (async () => {
      let buffer = "";
      try {
        const res = await fetch(`${getApiBaseUrl()}${opts.streamUrl}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let msg = res.statusText;
          try {
            const j = await res.json();
            msg = j.error || msg;
          } catch {
            /* keep statusText */
          }
          setError(msg);
          setPhase("error");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
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
            } & Partial<StreamPrompt>;
            try {
              json = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (json.type === "session" && json.sessionId) sessionIdRef.current = json.sessionId;
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
      }),
    [prepare],
  );
}
