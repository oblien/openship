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
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";
import { useModal } from "@/context/ModalContext";
import { PromptDetails } from "@/components/import-project/PromptDetails";
import { getApiBaseUrl } from "@/lib/api";

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
  /** POST endpoint answered with `{ sessionId, action }` for a prompt. */
  respondUrl: string;
  /** Modal heading. */
  title?: string;
  /** Copy overrides for the non-prompt phases. */
  labels?: { working?: string; done?: string; failed?: string; close?: string };
  /** Fired once on successful completion. */
  onDone?: () => void;
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
  const sessionIdRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  const respond = useCallback(
    async (action: string) => {
      setPrompt(null);
      const sid = sessionIdRef.current;
      if (!sid) return;
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

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
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
              const ok = json.status === "completed";
              setPhase(ok ? "completed" : "failed");
              setPrompt(null);
              if (ok) opts.onDone?.();
            }
          }
        }
      } catch (e) {
        if ((e as { name?: string })?.name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.streamUrl]);

  const l = opts.labels ?? {};
  const tail = logs.slice(-6);

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
            <span>{error || l.failed || "Couldn't finish — nothing was disrupted."}</span>
          </div>
          <div className="flex justify-end">
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
          {tail.length > 0 && (
            <div className="space-y-0.5 rounded-xl border border-border/50 bg-muted/20 p-3 font-mono text-[11px] text-muted-foreground">
              {tail.map((entry, i) => (
                <div key={i} className={entry.level === "error" ? "text-danger" : entry.level === "warn" ? "text-warning" : ""}>
                  {entry.message}
                </div>
              ))}
            </div>
          )}
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
