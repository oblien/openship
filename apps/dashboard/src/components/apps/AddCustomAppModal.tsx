"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";

import { useState } from "react";
import { isValidAppTemplate } from "@repo/core";
import { Modal } from "@/components/ui/Modal";
import { appsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * Upload a custom app JSON → validate → add it to this org's catalog as an
 * UNVERIFIED app. The SAME `isValidAppTemplate` runs client-side for instant
 * feedback; the server re-validates + stores (the authority). Trust is
 * provenance-based — an uploaded app is always unverified, whatever the JSON says.
 */
export function AddCustomAppModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const m = t.library.customAppModal;
  const { showToast } = useToast();
  const [template, setTemplate] = useState<unknown>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const evaluate = (text: string) => {
    setTemplate(null);
    setName(null);
    setError(null);
    if (!text.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      setError(m.invalidJson || "That file isn't valid JSON.");
      return;
    }
    if (!isValidAppTemplate(obj)) {
      setError(m.invalidDefinition || "This isn't a valid app definition — check the required fields and references.");
      return;
    }
    const t = obj as { kind?: string; name?: string; id?: string };
    if (t.kind !== "template") {
      setError(m.onlyTemplateSupported || "Only template apps can be added (flow apps aren't supported).");
      return;
    }
    setTemplate(obj);
    setName(t.name ?? t.id ?? "app");
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    evaluate(await f.text().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/components/apps/AddCustomAppModal"); return ""; }));
  };

  const submit = async () => {
    if (!template || busy) return;
    setBusy(true);
    try {
      await appsApi.addCustom(template);
      showToast(interpolate(m.addedToast || "Added \"{name}\" to your catalog.", { name: name || "app" }), "success");
      onAdded();
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, m.failedToast || "Couldn't add the app."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} width="560px" maxWidth="95vw" showCloseButton>
      <div className="p-6">
        <h3 className="text-base font-semibold text-foreground">{m.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {m.description}{" "}
          <a
            href="https://openship.io/docs/guides/add-an-app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {m.howToWrite}
          </a>
        </p>

        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFile(e.dataTransfer.files?.[0]);
          }}
          className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-background px-4 py-8 text-center transition-colors hover:border-primary/40"
        >
          <UiIcon name="cloud-upload" className="size-6 text-muted-foreground" />
          <span className="text-sm text-foreground">
            {m.dropPrefix} <code className="font-mono text-[12px]">app.json</code> {m.dropSuffix}{" "}
            <span className="text-primary">{m.browse}</span>
          </span>
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </label>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/[0.05] px-3 py-2.5 text-sm text-danger">
            <UiIcon name="warning" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {template != null && !error && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/[0.05] px-3 py-2.5 text-sm text-success">
              <UiIcon name="check-circle" className="size-4 shrink-0" />
              <span>
                {m.validDefinition} <span className="font-medium">{name}</span>
              </span>
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/[0.05] px-3 py-2.5 text-xs text-warning">
              <UiIcon name="warning" className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-semibold">{m.unverifiedTitle}</span> {m.unverifiedBody}
              </span>
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {m.cancel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!template || busy}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && <UiIcon name="spinner" className="size-4 animate-spin" />} {m.addApp}
          </button>
        </div>
      </div>
    </Modal>
  );
}
