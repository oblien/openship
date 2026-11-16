"use client";

import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type {
  RouteProtectionInput,
  RouteProtectionStatus,
  RouteProtectionOptions,
} from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tabs } from "@/components/ui/Tabs";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { HtmlDocumentEditor } from "./HtmlDocumentEditor";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { projectsApi, getApiErrorMessage } from "@/lib/api";
import { reportCaughtError } from "@repo/core/diagnostics";

export type RouteProtectionDraft = Extract<RouteProtectionInput, { action: "protect" }>;

interface Props {
  hostname: string;
  projectId?: string;
  unsupported?: boolean;
  draft?: RouteProtectionDraft;
  onDraftChange?: (draft: RouteProtectionDraft | undefined) => void;
}
const defaults: RouteProtectionOptions = {
  mode: "page",
  username: "visitor",
  sessionSeconds: 86400,
};

/** One editor for a staged wizard hostname and an already-published route. */
export function RouteProtectionButton(props: Props) {
  return <ProtectionEditor key={`${props.projectId ?? "draft"}:${props.hostname}`} {...props} />;
}

export function routeProtectionHref(projectId: string, hostname: string) {
  return `/projects/${encodeURIComponent(projectId)}/access?${new URLSearchParams({ hostname })}`;
}

/** The Access tab and the wizard share the same state, validation and mutation flow. */
export function RouteProtectionPanel(
  props: Pick<Props, "hostname" | "unsupported"> & { projectId: string },
) {
  return <ProtectionEditor key={`${props.projectId}:${props.hostname}`} {...props} inline />;
}

function ProtectionEditor({
  hostname,
  projectId,
  unsupported,
  draft,
  onDraftChange,
  inline = false,
}: Props & { inline?: boolean }) {
  const { t, locale } = useI18n();
  const w = t.widgets.routing.protection;
  const p = t.widgets.routing.pages;
  const titleId = useId();
  const passwordId = useId();
  const customPageId = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RouteProtectionStatus>();
  const [loading, setLoading] = useState(!!projectId);
  const [known, setKnown] = useState(!projectId);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const [options, setOptions] = useState<RouteProtectionOptions>(draft?.options ?? defaults);
  const [customPage, setCustomPage] = useState(!!draft?.options?.loginHtml);
  const close = () => {
    if (!busy) {
      setOpen(false);
      setPassword("");
      setConfirmUnlock(false);
    }
  };
  const { dialog, onKeyDown } = useDialogFocus(close, open && !inline);
  useEffect(() => {
    let active = true;
    setStatus(undefined);
    setKnown(!projectId);
    setError("");
    if (!projectId || unsupported) {
      setOptions(draft?.options ?? defaults);
      setCustomPage(!!draft?.options?.loginHtml);
      setLoading(false);
      return;
    }
    setLoading(true);
    // The API client's concurrent-GET dedupe shares this read across route cards.
    projectsApi
      .listRouteProtection(projectId)
      .then((result) => {
        if (active) {
          setStatus(result.data.find((row) => row.hostname === hostname));
          const next = result.data.find((row) => row.hostname === hostname)?.options ?? defaults;
          setOptions(next);
          setCustomPage(!!next.loginHtml);
          setKnown(true);
        }
      })
      .catch((err) => {
        if (active) setError(getApiErrorMessage(err, w.loadFailed));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, hostname, unsupported, w.loadFailed, refresh, open, draft]);

  const enabled = !!draft || status?.enabled === true;
  async function save(action: RouteProtectionInput["action"]) {
    setBusy(true);
    setError("");
    try {
      const input: RouteProtectionInput =
        action === "protect"
          ? {
              hostname,
              action,
              password: password || draft?.password || "",
              options: { ...options, loginHtml: customPage ? options.loginHtml : undefined },
            }
          : action === "configure"
            ? {
                hostname,
                action,
                options: { ...options, loginHtml: customPage ? options.loginHtml : undefined },
              }
            : { hostname, action };
      if (projectId) {
        const result = await projectsApi.changeRouteProtection(projectId, input);
        setStatus(result.data);
        setKnown(true);
      } else if (action === "protect") {
        onDraftChange?.(input as RouteProtectionDraft);
      } else {
        onDraftChange?.(undefined);
      }
      setPassword("");
      setConfirmUnlock(false);
      if (!projectId) setOpen(false);
    } catch (err) {
      setError(getApiErrorMessage(err, w.saveFailed));
      // A lost response may have saved the intent. Never infer that the route
      // stayed public or that the edge applied it from a failed HTTP request.
      if (projectId) {
        setKnown(false);
        try {
          const current = await projectsApi.listRouteProtection(projectId);
          setStatus(current.data.find((row) => row.hostname === hostname));
          setKnown(true);
        } catch (statusError) {
          reportCaughtError(statusError, "dashboard/route-protection");
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const applied = known && status?.enabled && status.status === "applied";
  const showHtml = options.mode !== "basic" && customPage;
  const lockClass = applied
    ? "text-success bg-success-bg hover:text-success hover:bg-success-bg"
    : status?.status === "pending"
      ? "text-warning"
      : undefined;
  const lockIcon = (
    <Icon name={loading ? "spinner" : "lock"} className={loading ? "animate-spin" : undefined} />
  );

  // Saved domain cards open their exact hostname in Access. Wizard controls
  // stay in the wizard, including an existing project's unpublished domains.
  if (!inline && projectId && !onDraftChange && !unsupported) {
    return (
      <Button variant="ghost" size="icon" className={lockClass} asChild>
        <Link
          href={routeProtectionHref(projectId, hostname)}
          prefetch={false}
          title={w.title}
          aria-label={`${w.title}: ${hostname}`}
        >
          {lockIcon}
        </Link>
      </Button>
    );
  }

  const passwordControls = (
    <section className="min-w-0 space-y-4 rounded-2xl bg-card p-5">
      <label htmlFor={passwordId} className="block text-sm font-medium">
        {enabled ? w.newPassword : w.password}
      </label>
      <Input
        id={passwordId}
        variant="filled"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        minLength={12}
        maxLength={256}
        required={!enabled}
        disabled={busy || loading}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {enabled ? p.passwordOptional : w.passwordHint}
      </p>
      <Button
        type="submit"
        className="w-full"
        disabled={
          busy ||
          loading ||
          !known ||
          !hostname ||
          ((!enabled || !!password) && new TextEncoder().encode(password).length < 12)
        }
      >
        {busy ? <Icon name="spinner" className="animate-spin" /> : <Icon name="lock" />}
        {p.saveAccess}
      </Button>
      {status?.status === "pending" && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void save("retry")}
        >
          {w.retry}
        </Button>
      )}
      {enabled && (
        <div className="flex flex-wrap gap-2">
          {projectId && options.mode !== "basic" && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void save("revoke")}
            >
              {w.revoke}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmUnlock(true)}
          >
            {w.remove}
          </Button>
        </div>
      )}
      {confirmUnlock && (
        <div className="space-y-3 rounded-xl bg-muted/40 p-4">
          <p className="text-sm">{w.unlockConfirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void save("unlock")}
            >
              {w.unlock}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmUnlock(false)}
            >
              {w.cancel}
            </Button>
          </div>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <DisclosureSummary className="cursor-pointer">{p.scope}</DisclosureSummary>
        <p className="mt-2 leading-relaxed">{w.scope}</p>
      </details>
    </section>
  );

  const content = unsupported ? (
    <p className="text-sm text-muted-foreground">{w.unsupported}</p>
  ) : (
    <div className="@container/protection space-y-4">
      <p
        role="status"
        className={`flex items-center gap-2 text-sm ${applied ? "text-success" : status?.status === "pending" ? "text-warning" : "text-muted-foreground"}`}
      >
        <Icon name="lock" size={16} />
        {loading
          ? w.loading
          : !known
            ? w.unknown
            : draft
              ? w.staged
              : status?.status === "pending"
                ? w.pending
                : applied
                  ? w.protected
                  : w.public}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!known && !loading && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {w.retry}
        </Button>
      )}
      <form
        className={`grid items-start gap-5 ${showHtml ? "@3xl/protection:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" : inline ? "@3xl/protection:grid-cols-2" : ""}`}
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void save(enabled && projectId && !password ? "configure" : "protect");
        }}
      >
        <div className="min-w-0 space-y-5">
          <section className="min-w-0 space-y-4 rounded-2xl bg-card p-5">
            <h3 className="text-sm font-medium">{p.signIn}</h3>
            <Tabs
              tabs={[
                { key: "page", label: p.signInPage },
                { key: "basic", label: p.browserAuth },
              ]}
              value={options.mode}
              onChange={(mode) => !busy && !loading && setOptions({ ...options, mode })}
              variant="pills"
              size="sm"
              className="flex-wrap"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {options.mode === "basic" ? p.browserHint : p.signInHint}
            </p>
            {options.mode === "basic" ? (
              <label className="block space-y-2 text-sm">
                <span>{p.username}</span>
                <Input
                  variant="filled"
                  value={options.username ?? "visitor"}
                  disabled={busy || loading}
                  pattern="[A-Za-z0-9._-]+"
                  maxLength={64}
                  required
                  onChange={(event) => setOptions({ ...options, username: event.target.value })}
                />
              </label>
            ) : (
              <>
                <label className="block space-y-2 text-sm">
                  <span>{p.session}</span>
                  <CustomSelect
                    value={String(options.sessionSeconds)}
                    disabled={busy || loading}
                    aria-label={p.session}
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    options={[
                      { value: "3600", label: p.hour },
                      { value: "86400", label: p.day },
                      { value: "604800", label: p.week },
                      ...([3600, 86400, 604800].includes(options.sessionSeconds)
                        ? []
                        : [
                            {
                              value: String(options.sessionSeconds),
                              label: new Intl.NumberFormat(locale, {
                                style: "unit",
                                unit: "minute",
                              }).format(options.sessionSeconds / 60),
                            },
                          ]),
                    ]}
                    onChange={(value) => setOptions({ ...options, sessionSeconds: Number(value) })}
                  />
                </label>
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={customPageId}
                    checked={customPage}
                    disabled={busy || loading}
                    onCheckedChange={(checked) => {
                      setCustomPage(checked);
                      if (!options.loginHtml)
                        setOptions({
                          ...options,
                          loginHtml:
                            '<!doctype html>\n<html><meta charset="utf-8"><title>Private site</title>\n<body><main><h1>This site is private</h1>\n{{form}}\n</main></body></html>',
                        });
                    }}
                  />
                  <label htmlFor={customPageId} className="cursor-pointer">
                    {p.customSignIn}
                  </label>
                </div>
              </>
            )}
          </section>
          {showHtml && passwordControls}
        </div>
        {showHtml ? (
          <section className="min-w-0 rounded-2xl bg-card p-5">
            <HtmlDocumentEditor
              value={options.loginHtml ?? ""}
              disabled={busy || loading}
              hint={p.formHint}
              rows={16}
              onChange={(loginHtml) => setOptions({ ...options, loginHtml })}
            />
          </section>
        ) : (
          passwordControls
        )}
      </form>
    </div>
  );

  if (inline) return content;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={w.title}
        aria-label={`${w.title}: ${hostname}`}
        className={lockClass}
        onClick={() => setOpen(true)}
      >
        {lockIcon}
      </Button>
      <Modal
        isOpen={open}
        onClose={close}
        width={showHtml ? "1040px" : "560px"}
        maxWidth="calc(100vw - 32px)"
        closable={!busy}
      >
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="space-y-5 p-6"
        >
          <div className="pe-8">
            <h2 id={titleId} className="text-lg font-semibold">
              {w.title}
            </h2>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {hostname || w.chooseHostname}
            </p>
          </div>
          {content}
        </div>
      </Modal>
    </>
  );
}
