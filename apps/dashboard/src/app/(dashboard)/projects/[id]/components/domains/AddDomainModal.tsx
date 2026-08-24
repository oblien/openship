"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { domainsApi } from "@/lib/api";
import { DnsRecordsTable, mergeCheckedRecords, type DnsTableRecord } from "./DnsRecordsTable";

export interface AddDomainDraft {
  domainType: "free" | "custom";
  hostname: string;
  port: string;
  path: string;
  includeWww: boolean;
  externalIngress: boolean;
}

type WizardStep = "details" | "dns";

export function AddDomainModal({
  open,
  onClose,
  projectId,
  projectLabel,
  baseDomain,
  hasServer,
  defaultPort,
  onRequireCloud,
  onCopy,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectLabel: string;
  baseDomain: string;
  hasServer: boolean;
  defaultPort: string;
  onRequireCloud: () => Promise<boolean>;
  onCopy: (text: string) => void | Promise<void>;
  onAdd: (draft: AddDomainDraft) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const add = t.projectSettings.domains.add;
  const s = t.projectSettings.domains.setup;

  const [step, setStep] = useState<WizardStep>("details");
  const [domainType, setDomainType] = useState<"free" | "custom">("custom");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState(defaultPort);
  const [path, setPath] = useState("/");
  const [includeWww, setIncludeWww] = useState(false);
  const [externalIngress, setExternalIngress] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [records, setRecords] = useState<DnsTableRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkRan, setCheckRan] = useState(false);
  const [allOk, setAllOk] = useState(false);

  const trimmed = hostname.trim().toLowerCase();
  const hasWwwPrefix = domainType === "custom" && trimmed.startsWith("www.");
  const looksValidCustom =
    trimmed.length > 0 &&
    trimmed.includes(".") &&
    !trimmed.startsWith(".") &&
    !trimmed.endsWith(".") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(trimmed) &&
    trimmed !== baseDomain.toLowerCase() &&
    !trimmed.endsWith(`.${baseDomain.toLowerCase()}`);

  const previewName = domainType === "custom" ? trimmed : trimmed ? `${trimmed}.${baseDomain}` : "";

  const draft = useMemo<AddDomainDraft>(
    () => ({
      domainType,
      hostname: trimmed,
      port: port.trim(),
      path: path.trim() || "/",
      includeWww,
      externalIngress,
    }),
    [domainType, trimmed, port, path, includeWww, externalIngress],
  );

  useEffect(() => {
    if (!open) return;
    setStep("details");
    setDomainType("custom");
    setHostname("");
    setPort(defaultPort);
    setPath("/");
    setIncludeWww(false);
    setExternalIngress(false);
    setAdvancedOpen(false);
    setSubmitting(false);
    setRecords([]);
    setPreviewError(null);
    setCheckError(null);
    setCheckRan(false);
    setAllOk(false);
  }, [open, defaultPort]);

  const detailsReady =
    trimmed.length > 0 &&
    !hasWwwPrefix &&
    (domainType === "free" || looksValidCustom) &&
    (!hasServer || !!port.trim());

  const loadPreview = async () => {
    setRecordsLoading(true);
    setPreviewError(null);
    setCheckRan(false);
    setAllOk(false);
    try {
      const result = await domainsApi.previewRecords({
        hostname: trimmed,
        projectId,
        includeWww,
        externalIngress,
      });
      setRecords(result.data.records);
    } catch {
      setRecords([]);
      setPreviewError(s.previewFailed);
    } finally {
      setRecordsLoading(false);
    }
  };

  const handleContinue = async () => {
    if (!detailsReady) return;
    if (domainType === "free") {
      setSubmitting(true);
      try {
        const ok = await onAdd(draft);
        if (ok) onClose();
      } finally {
        setSubmitting(false);
      }
      return;
    }
    setStep("dns");
    await loadPreview();
  };

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    try {
      const result = await domainsApi.checkRecords({
        hostname: trimmed,
        projectId,
        includeWww,
        externalIngress,
      });
      setRecords(mergeCheckedRecords(records, result.data.records));
      setAllOk(result.data.allOk);
      setCheckRan(true);
    } catch {
      setCheckError(s.checkFailed);
    } finally {
      setChecking(false);
    }
  };

  const handleAdd = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const ok = await onAdd(draft);
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      maxWidth="32rem"
      width="100%"
      closable={!submitting}
    >
      <div className="flex min-h-0 flex-col">
        <div className="border-b border-border/40 px-5 pb-3 pt-4 pe-12">
          <h2 className="text-[15px] font-semibold text-foreground">{s.title}</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            {step === "details" ? s.subtitle : interpolate(s.dnsFor, { hostname: previewName })}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === "details" ? (
            <div className="space-y-3">
              <div role="radiogroup" aria-label={s.typeGroup} className="grid gap-2">
                <TypeChoice
                  selected={domainType === "custom"}
                  title={s.typeOwn}
                  hint={s.typeOwnHint}
                  onSelect={() => {
                    if (domainType === "custom") return;
                    setDomainType("custom");
                    setHostname("");
                  }}
                />
                <TypeChoice
                  selected={domainType === "free"}
                  title={s.typeFree}
                  hint={interpolate(s.typeFreeHint, { domain: baseDomain })}
                  onSelect={async () => {
                    if (domainType === "free") return;
                    if (!(await onRequireCloud())) return;
                    setDomainType("free");
                    setHostname(projectLabel || "");
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-foreground">
                  {domainType === "free" ? s.freeQuestion : s.domainQuestion}
                </label>
                <div className="flex items-center overflow-hidden rounded-lg border border-border bg-background focus-within:border-foreground/40">
                  <input
                    autoFocus
                    placeholder={domainType === "custom" ? add.customPlaceholder : projectLabel || add.defaultAppName}
                    value={hostname}
                    onChange={(event) => setHostname(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleContinue();
                    }}
                    className="flex-1 bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  {domainType === "free" ? (
                    <span className="shrink-0 pe-3 text-sm text-muted-foreground">.{baseDomain}</span>
                  ) : null}
                </div>
                {hasWwwPrefix ? <p className="text-xs text-danger">{add.noWww}</p> : null}
                {previewName ? (
                  <p className="text-[12px] text-muted-foreground">
                    {interpolate(s.willServe, { hostname: previewName })}
                  </p>
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    {domainType === "free" ? interpolate(s.typeFreeHint, { domain: baseDomain }) : s.domainHint}
                  </p>
                )}
              </div>

              {domainType === "custom" && trimmed ? (
                <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
                  <span className="text-[13px] text-foreground">
                    {interpolate(s.alsoWww, { domain: trimmed || add.includeWwwFallback })}
                  </span>
                  <Switch checked={includeWww} onChange={setIncludeWww} ariaLabel={add.includeWww} />
                </label>
              ) : null}

              <button
                type="button"
                onClick={() => setAdvancedOpen((value) => !value)}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`size-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
                {s.moreOptions}
              </button>
              {advancedOpen ? (
                <div className="space-y-3 rounded-lg border border-border/50 px-3 py-3">
                  {hasServer ? (
                    <div className="space-y-1.5">
                      <label className="text-[13px] font-medium text-foreground">{add.mapsToPort}</label>
                      <input
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                        placeholder={defaultPort || "3000"}
                        inputMode="numeric"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
                      />
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <label className="text-[13px] font-medium text-foreground">{add.servesPath}</label>
                      <input
                        value={path}
                        onChange={(event) => setPath(event.target.value)}
                        placeholder="/"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
                      />
                      <p className="text-[12px] text-muted-foreground">{add.servesPathHint}</p>
                    </div>
                  )}
                  {domainType === "custom" ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-foreground">{add.externalIngress}</p>
                        <p className="text-[12px] text-muted-foreground">{add.externalIngressDesc}</p>
                      </div>
                      <Switch
                        checked={externalIngress}
                        onChange={setExternalIngress}
                        ariaLabel={add.externalIngress}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              {recordsLoading ? (
                <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t.projectSettings.domains.records.loading}
                </div>
              ) : records.length > 0 ? (
                <DnsRecordsTable
                  records={records}
                  checking={checking}
                  onCheck={() => void handleCheck()}
                  onCopy={onCopy}
                />
              ) : (
                <p className="py-4 text-[13px] text-muted-foreground">
                  {previewError || t.projectSettings.domains.records.none}
                </p>
              )}
              {checkError ? <p className="text-[12px] text-danger">{checkError}</p> : null}
              {checkRan && allOk ? (
                <p className="text-[12px] font-medium text-success">{s.dnsAllOk}</p>
              ) : null}
              {checkRan && !allOk ? (
                <p className="text-[12px] text-warning">{s.dnsSomeFail}</p>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/40 px-5 py-3">
          {step === "dns" ? (
            <button
              type="button"
              onClick={() => setStep("details")}
              disabled={submitting}
              className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-foreground/[0.06] disabled:opacity-50"
            >
              {s.back}
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-foreground/[0.06] disabled:opacity-50"
            >
              {s.cancel}
            </button>
          )}
          {step === "details" ? (
            <button
              type="button"
              onClick={() => void handleContinue()}
              disabled={!detailsReady || submitting}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[13px] font-medium text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : domainType === "free" ? <Plus className="size-3.5" /> : null}
              {submitting ? add.adding : domainType === "free" ? add.submit : s.continue}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={submitting}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[13px] font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {submitting ? add.adding : s.addNow}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TypeChoice({
  selected,
  title,
  hint,
  onSelect,
}: {
  selected: boolean;
  title: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors ${
        selected
          ? "border-foreground/50 bg-foreground/[0.04]"
          : "border-border/70 hover:border-foreground/25 hover:bg-foreground/[0.02]"
      }`}
    >
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-foreground" : "border-muted-foreground/50"
        }`}
      >
        {selected ? <span className="size-2 rounded-full bg-foreground" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-foreground">{title}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
