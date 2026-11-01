"use client";

import { useEffect, useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import type { RouteProtectionInput, RouteProtectionStatus } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/** One editor for a staged wizard hostname and an already-published route. */
export function RouteProtectionButton({
  hostname,
  projectId,
  unsupported,
  draft,
  onDraftChange,
}: Props) {
  const { t } = useI18n();
  const w = t.widgets.routing.protection;
  const titleId = useId();
  const passwordId = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RouteProtectionStatus>();
  const [loading, setLoading] = useState(!!projectId);
  const [known, setKnown] = useState(!projectId);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const close = () => {
    if (!busy) {
      setOpen(false);
      setPassword("");
      setConfirmUnlock(false);
    }
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  useEffect(() => {
    let active = true;
    setStatus(undefined);
    setKnown(!projectId);
    setError("");
    if (!projectId || unsupported) {
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
  }, [projectId, hostname, unsupported, w.loadFailed, refresh, open]);

  const enabled = !!draft || status?.enabled === true;
  async function save(action: RouteProtectionInput["action"]) {
    setBusy(true);
    setError("");
    try {
      const input: RouteProtectionInput =
        action === "protect" ? { hostname, action, password } : { hostname, action };
      if (projectId) {
        const result = await projectsApi.changeRouteProtection(projectId, input);
        setStatus(result.data);
        setKnown(true);
      } else if (action === "protect") {
        onDraftChange?.({ hostname, action, password });
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
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={w.title}
        aria-label={`${w.title}: ${hostname}`}
        className={applied ? "text-primary" : undefined}
        onClick={() => setOpen(true)}
      >
        <Icon
          name={loading ? "spinner" : "lock"}
          className={loading ? "animate-spin" : undefined}
        />
      </Button>
      <Modal
        isOpen={open}
        onClose={close}
        width="440px"
        maxWidth="calc(100vw - 32px)"
        closable={!busy}
      >
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
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
          {unsupported ? (
            <p className="text-sm text-muted-foreground">{w.unsupported}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{w.description}</p>
              <p
                className={`rounded-xl bg-muted/40 p-3 text-sm ${applied ? "text-primary" : "text-muted-foreground"}`}
              >
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
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save("protect");
                }}
              >
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
                  required
                  disabled={busy || loading}
                />
                <p className="text-xs text-muted-foreground">{w.passwordHint}</p>
                <Button
                  type="submit"
                  disabled={
                    busy || loading || !hostname || new TextEncoder().encode(password).length < 12
                  }
                  className="w-full"
                >
                  {busy ? <Icon name="spinner" className="animate-spin" /> : <Icon name="lock" />}
                  {w.save}
                </Button>
              </form>
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
                  {projectId && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void save("revoke")}
                    >
                      {w.revoke}
                    </Button>
                  )}
                  <Button
                    type="button"
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
                  <div className="flex gap-2">
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
              <p className="text-xs text-muted-foreground">{w.scope}</p>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
