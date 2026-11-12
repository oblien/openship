"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { normalizeEdgeResponse, normalizeResponsePath, EDGE_RESPONSE_MAX_BYTES } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { projectsApi, getApiErrorMessage, type RouteRuleRow } from "@/lib/api";

type Draft = {
  id?: string;
  path: string;
  match: "exact" | "prefix";
  status: string;
  contentType: string;
  body: string;
  methods: string;
  headers: Array<{ name: string; value: string }>;
};
const blank = (): Draft => ({
  path: "",
  match: "exact",
  status: "200",
  contentType: "text/plain; charset=utf-8",
  body: "",
  methods: "GET, HEAD",
  headers: [],
});
const fromRule = (rule: RouteRuleRow): Draft => ({
  id: rule.id,
  path: rule.pathPrefix || "/",
  match: rule.spec.response!.match,
  status: String(rule.spec.response!.status),
  contentType: rule.spec.response!.contentType,
  body: rule.spec.response!.body,
  methods: rule.spec.response!.methods.join(", "),
  headers: Object.entries(rule.spec.response!.headers).map(([name, value]) => ({ name, value })),
});

/** The same domain editor is used by single-app, service and project route cards. */
export function DomainResponseRoutes({
  projectId,
  domainId,
  hostname,
}: {
  projectId: string;
  domainId: string;
  hostname: string;
}) {
  const { t, locale } = useI18n();
  const w = t.projectSettings.responseRoutes;
  const labelId = useId();
  const [rules, setRules] = useState<RouteRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const mutation = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const close = () => {
    if (!mutation.current) setOpen(false);
  };
  const { dialog, onKeyDown } = useDialogFocus(close, open);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await projectsApi.listRouteRules(projectId);
      if (alive.current)
        setRules(result.rules.filter((rule) => rule.domainId === domainId && rule.spec.response));
    } catch (cause) {
      if (alive.current) setLoadError(getApiErrorMessage(cause, w.loadFailed));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectId, domainId, w.loadFailed]);
  useEffect(() => {
    void load();
  }, [load]);

  const update = (patch: Partial<Draft>) =>
    setDraft((current) => current && { ...current, ...patch });
  const edit = (rule?: RouteRuleRow) => {
    setDraft((current) =>
      current && current.id === rule?.id ? current : rule ? fromRule(rule) : blank(),
    );
    setError("");
    setPreview(false);
    setOpen(true);
  };
  const run = async (operation: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (alive.current) setError(getApiErrorMessage(cause, w.saveFailed));
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!draft) return;
      const path = normalizeResponsePath(draft.path);
      const headers: Record<string, string> = {};
      for (const row of draft.headers) {
        if (!row.name && !row.value) continue;
        const name = row.name.trim().toLowerCase();
        if (Object.hasOwn(headers, name)) throw new Error(w.duplicateHeader);
        Object.defineProperty(headers, name, { value: row.value, enumerable: true });
      }
      const response = normalizeEdgeResponse({
        match: draft.match,
        status: Number(draft.status),
        contentType: draft.contentType.trim(),
        body: draft.body,
        headers,
        methods: draft.methods
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((value) => value.toUpperCase()),
      });
      const input = { domainId, pathPrefix: path, spec: { response } };
      const result = draft.id
        ? await projectsApi.updateRouteRule(projectId, draft.id, input)
        : await projectsApi.createRouteRule(projectId, { ...input, enabled: true });
      if (!alive.current) return;
      setRules((current) => [...current.filter((rule) => rule.id !== result.rule.id), result.rule]);
      setDraft(null);
      setOpen(false);
      setNotice(result.rule.edgeApplied === true ? w.saved : w.pending);
    });
  const toggle = (rule: RouteRuleRow) =>
    run(async () => {
      const result = await projectsApi.updateRouteRule(projectId, rule.id, {
        enabled: !rule.enabled,
      });
      if (alive.current) {
        setRules((current) => current.map((row) => (row.id === rule.id ? result.rule : row)));
        setNotice(result.rule.edgeApplied === true ? w.saved : w.pending);
      }
    });
  const remove = (rule: RouteRuleRow) =>
    run(async () => {
      const result = await projectsApi.deleteRouteRule(projectId, rule.id);
      if (!alive.current) return;
      setRules((current) => current.filter((row) => row.id !== rule.id));
      setRemoveId(null);
      setNotice(result.edgeApplied === true ? w.saved : w.pending);
      if (draft?.id === rule.id) setDraft(null);
    });
  const contentTypes = [
    { value: "text/plain; charset=utf-8", label: w.plainText },
    { value: "application/json", label: "JSON" },
    { value: "text/html; charset=utf-8", label: "HTML" },
    { value: "application/xml", label: "XML" },
  ];
  const format =
    draft && contentTypes.some((type) => type.value === draft.contentType)
      ? draft.contentType
      : "custom";
  const contentBytes = new TextEncoder().encode(draft?.body ?? "").length;
  const fieldClass = "bg-muted/60 ring-1 ring-inset ring-border/50 focus:bg-muted/80";
  const bodyless = draft && [204, 205, 304].includes(Number(draft.status));

  return (
    <section
      className="border-t border-border/40 px-5 py-4"
      aria-label={`${w.title} · ${hostname}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">{w.title}</h4>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || !!loadError || busy}
          onClick={() => edit()}
        >
          <Icon name="plus" className="size-3.5" />
          {w.add}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{w.description}</p>
      {loading && (
        <div className="mt-3 h-10 animate-pulse rounded-lg bg-muted" aria-label={w.loading} />
      )}
      {loadError && (
        <div className="mt-3 flex items-center gap-2">
          <p role="alert" className="text-xs text-danger">
            {loadError}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            {w.retry}
          </Button>
        </div>
      )}
      {!open && error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="mt-3 space-y-2">
        {rules.map((rule) => {
          const path = rule.pathPrefix || "/";
          const response = rule.spec.response!;
          return (
            <div key={rule.id} className="rounded-xl bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => edit(rule)}
                  disabled={busy}
                  aria-label={`${w.edit} ${path}`}
                  className="min-w-0 flex-1 rounded-md py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block break-all font-mono text-sm text-foreground" dir="ltr">
                    {path}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {response.status} · {response.contentType.split(";")[0]} ·{" "}
                    {response.match === "exact" ? w.exact : w.prefix}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void toggle(rule)}
                  disabled={busy}
                  aria-label={`${rule.enabled ? w.disable : w.enable} ${path}`}
                  aria-pressed={rule.enabled}
                  className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  {rule.enabled ? w.enabled : w.disabled}
                </button>
                <button
                  type="button"
                  onClick={() => setRemoveId(rule.id)}
                  disabled={busy}
                  aria-label={`${w.remove} ${path}`}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Icon name="trash" className="size-3.5" />
                </button>
              </div>
              {removeId === rule.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/40 pt-2">
                  <p className="flex-1 text-xs text-muted-foreground">{w.removeHint}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRemoveId(null)}
                  >
                    {w.cancel}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(rule)}
                  >
                    {w.remove}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Modal
        isOpen={open}
        onClose={close}
        closable={!busy}
        showCloseButton={false}
        width="920px"
        maxWidth="calc(100vw - 32px)"
        height="min(720px, calc(100dvh - 32px))"
        maxHeight="calc(100dvh - 32px)"
        overflow="hidden"
      >
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="flex min-h-0 flex-1 flex-col outline-none"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-4 sm:px-6">
              <div className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground sm:flex">
                <Icon name="route" className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id={labelId} className="text-lg font-semibold text-foreground">
                  {draft?.id ? w.edit : w.add}
                </h3>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="ltr">
                  {hostname}
                </p>
              </div>
              <span className="hidden rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground sm:inline-flex">
                {w.staticResponse}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={close}
                disabled={busy}
                aria-label={w.close}
                className="shrink-0 text-muted-foreground"
              >
                <Icon name="close" className="size-4" />
              </Button>
            </header>
            {draft && (
              <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                data-response-editor-scroll
              >
                <fieldset
                  disabled={busy}
                  className="grid min-w-0 gap-6 p-5 sm:p-6 md:grid-cols-[minmax(0,1fr)_260px]"
                >
                  <div className="min-w-0 space-y-5">
                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(130px,0.7fr)] gap-3">
                        <label className="block space-y-2 text-sm font-medium text-foreground">
                          <span>{w.path}</span>
                          <Input
                            variant="filled"
                            className={`${fieldClass} font-mono`}
                            value={draft.path}
                            onChange={(event) => update({ path: event.target.value })}
                            placeholder="/health"
                            required
                            dir="ltr"
                            autoFocus
                          />
                        </label>
                        <div className="space-y-2 text-sm font-medium text-foreground">
                          <span>{w.match}</span>
                          <CustomSelect
                            aria-label={w.match}
                            variant="filled"
                            triggerClassName="bg-muted/60 hover:bg-muted ring-1 ring-inset ring-border/50"
                            value={draft.match}
                            disabled={busy}
                            options={[
                              { value: "exact", label: w.exact },
                              { value: "prefix", label: w.prefix },
                            ]}
                            onChange={(match) => update({ match })}
                          />
                        </div>
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {draft.match === "exact" ? w.exactHint : w.prefixHint}
                      </p>
                    </div>
                    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
                      <label className="block space-y-2 text-sm font-medium text-foreground">
                        <span>{w.status}</span>
                        <Input
                          variant="filled"
                          className={`${fieldClass} font-mono`}
                          type="number"
                          min={200}
                          max={599}
                          value={draft.status}
                          onChange={(event) => update({ status: event.target.value })}
                          dir="ltr"
                        />
                      </label>
                      <div className="space-y-2 text-sm font-medium text-foreground">
                        <span>{w.contentType}</span>
                        <CustomSelect
                          aria-label={w.contentType}
                          variant="filled"
                          triggerClassName="bg-muted/60 hover:bg-muted ring-1 ring-inset ring-border/50"
                          value={format}
                          disabled={busy}
                          options={[...contentTypes, { value: "custom", label: w.custom }]}
                          onChange={(value) =>
                            update({ contentType: value === "custom" ? "" : value })
                          }
                        />
                      </div>
                    </div>
                    {format === "custom" && (
                      <label className="block space-y-2 text-sm font-medium text-foreground">
                        <span>{w.customContentType}</span>
                        <Input
                          variant="filled"
                          className={`${fieldClass} font-mono`}
                          aria-label={w.customContentType}
                          value={draft.contentType}
                          onChange={(event) => update({ contentType: event.target.value })}
                          placeholder="image/svg+xml"
                          required
                          dir="ltr"
                        />
                      </label>
                    )}
                    <div className="space-y-2">
                      <div className="overflow-hidden rounded-xl border border-border/60 bg-background">
                        <div
                          role="group"
                          aria-label={w.staticResponse}
                          className="flex flex-wrap items-center gap-1 border-b border-border/50 bg-muted/40 p-1.5"
                        >
                          {[
                            { value: false, label: w.body, icon: "code" as const },
                            { value: true, label: w.preview, icon: "eye" as const },
                          ].map((view) => (
                            <button
                              key={String(view.value)}
                              type="button"
                              aria-pressed={preview === view.value}
                              onClick={() => setPreview(view.value)}
                              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${preview === view.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                            >
                              <Icon name={view.icon} className="size-3.5" />
                              {view.label}
                            </button>
                          ))}
                        </div>
                        {preview ? (
                          <pre
                            aria-label={w.preview}
                            className="h-[212px] overflow-auto whitespace-pre-wrap break-all p-3.5 font-mono text-xs leading-6 text-foreground"
                            dir="ltr"
                          >{`HTTP/1.1 ${draft.status}\nContent-Type: ${draft.contentType}\n${draft.headers
                            .filter((row) => row.name)
                            .map((row) => `${row.name}: ${row.value}\n`)
                            .join("")}\n${draft.body}`}</pre>
                        ) : (
                          <Textarea
                            variant="filled"
                            aria-label={w.body}
                            rows={7}
                            value={draft.body}
                            onChange={(event) => update({ body: event.target.value })}
                            dir="ltr"
                            className="h-[212px] resize-none rounded-none bg-background p-3.5 font-mono text-sm leading-6 focus-visible:ring-inset focus-visible:ring-offset-0"
                            placeholder={w.bodyPlaceholder}
                            spellCheck={false}
                          />
                        )}
                        <div className="flex items-center justify-between gap-3 border-t border-border/50 px-3.5 py-2 text-xs text-muted-foreground">
                          <span>UTF-8</span>
                          <span
                            className={contentBytes > EDGE_RESPONSE_MAX_BYTES ? "text-danger" : ""}
                            dir="ltr"
                          >
                            {contentBytes.toLocaleString(locale)} /{" "}
                            {EDGE_RESPONSE_MAX_BYTES.toLocaleString(locale)} {w.bytes}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {bodyless ? w.emptyBodyHint : w.bodyHint}
                      </p>
                    </div>
                  </div>
                  <aside className="min-w-0 space-y-6 border-t border-border/50 pt-5 md:border-s md:border-t-0 md:ps-5 md:pt-0">
                    <section className="space-y-3" aria-label={w.headers}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-medium text-foreground">{w.headers}</h4>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={w.addHeader}
                          title={w.addHeader}
                          disabled={draft.headers.length >= 32}
                          onClick={() =>
                            update({ headers: [...draft.headers, { name: "", value: "" }] })
                          }
                          className="h-8 w-8 p-0"
                        >
                          <Icon name="plus" className="size-4" />
                        </Button>
                      </div>
                      {!draft.headers.length && (
                        <p className="text-xs leading-5 text-muted-foreground">{w.headersHint}</p>
                      )}
                      {draft.headers.map((header, index) => (
                        <div key={index} className="space-y-2 rounded-xl bg-muted/40 p-2.5">
                          <div className="flex items-center gap-1.5">
                            <Input
                              variant="filled"
                              className="h-10 min-w-0 font-mono text-xs ring-1 ring-inset ring-border/40"
                              aria-label={`${w.headerName} ${index + 1}`}
                              placeholder="Cache-Control"
                              value={header.name}
                              dir="ltr"
                              onChange={(event) =>
                                update({
                                  headers: draft.headers.map((row, i) =>
                                    i === index ? { ...row, name: event.target.value } : row,
                                  ),
                                })
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`${w.removeHeader} ${index + 1}`}
                              onClick={() =>
                                update({ headers: draft.headers.filter((_, i) => i !== index) })
                              }
                              className="size-7 shrink-0 text-muted-foreground"
                            >
                              <Icon name="close" className="size-3.5" />
                            </Button>
                          </div>
                          <Input
                            variant="filled"
                            className="h-10 font-mono text-xs ring-1 ring-inset ring-border/40"
                            aria-label={`${w.headerValue} ${index + 1}`}
                            placeholder="no-store"
                            value={header.value}
                            dir="ltr"
                            onChange={(event) =>
                              update({
                                headers: draft.headers.map((row, i) =>
                                  i === index ? { ...row, value: event.target.value } : row,
                                ),
                              })
                            }
                          />
                        </div>
                      ))}
                    </section>
                    <section className="space-y-3 border-t border-border/50 pt-5">
                      <label className="block space-y-2 text-sm font-medium text-foreground">
                        <span>{w.methods}</span>
                        <Input
                          variant="filled"
                          className={`${fieldClass} font-mono text-xs`}
                          aria-label={w.methods}
                          value={draft.methods}
                          onChange={(event) => update({ methods: event.target.value })}
                          placeholder="GET, HEAD"
                          dir="ltr"
                        />
                      </label>
                      <p className="text-xs leading-5 text-muted-foreground">{w.methodsHint}</p>
                    </section>
                  </aside>
                </fieldset>
              </div>
            )}
            <footer className="shrink-0 space-y-3 border-t border-border/50 px-5 py-4 sm:px-6">
              {error && (
                <p role="alert" className="max-h-20 overflow-auto text-sm text-danger">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <p className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                  <Icon name="globe" className="size-3.5 shrink-0" />
                  {w.applyHint}
                </p>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setDraft(null);
                      close();
                    }}
                    className="flex-1 sm:flex-none"
                  >
                    {w.cancel}
                  </Button>
                  <Button type="submit" disabled={busy} className="flex-1 sm:flex-none">
                    {busy && <Icon name="spinner" className="size-4 animate-spin" />}
                    {w.save}
                  </Button>
                </div>
              </div>
            </footer>
          </form>
        </div>
      </Modal>
    </section>
  );
}
