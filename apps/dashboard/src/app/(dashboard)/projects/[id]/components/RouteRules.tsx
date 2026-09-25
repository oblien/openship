"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { projectsApi, getApiErrorMessage, type RouteRuleRow } from "@/lib/api";
import type { RouteRuleSpec } from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

/** Split on whitespace/commas — for tokens that never contain spaces (IPs, countries, methods, hosts). */
function tokens(v: string): string[] {
  return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Split on comma/newline only — for user-agent substrings, which may contain spaces. */
function commaList(v: string): string[] {
  return v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function summarize(spec: RouteRuleSpec): string {
  const parts: string[] = [];
  if (spec.rateLimit) parts.push(`${spec.rateLimit.rps}/s +${spec.rateLimit.burst}`);
  if (spec.access?.methods?.length) parts.push(spec.access.methods.join("/"));
  const banned =
    (spec.ban?.ips?.length ?? 0) + (spec.ban?.cidrs?.length ?? 0) + (spec.ban?.countries?.length ?? 0);
  if (banned) parts.push(`ban ${banned}`);
  if (spec.ban?.userAgents?.length || spec.ban?.emptyUserAgent) parts.push("ua");
  if (spec.access?.denyCidrs?.length) parts.push(`deny ${spec.access.denyCidrs.length}`);
  if (spec.access?.allowCidrs?.length) parts.push(`allow ${spec.access.allowCidrs.length}`);
  if (spec.access?.allowCountries?.length) parts.push(`allow ${spec.access.allowCountries.join("/")}`);
  if (spec.hotlink?.allowReferers?.length) parts.push("hotlink");
  if (spec.block?.status) parts.push(`→${spec.block.status}`);
  return parts.join(" · ") || "—";
}

export function RouteRules() {
  const { projectData } = useProjectSettings();
  const { showToast } = useToast();
  const { t } = useI18n();
  const w = t.projectSettings.routeRules;

  const [rules, setRules] = useState<RouteRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Collapsed by default (advanced/optional, like the routing card); auto-opens
  // once on load when the project actually has rules.
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);

  // New-rule form
  const [pathPrefix, setPathPrefix] = useState("");
  const [rps, setRps] = useState("");
  const [burst, setBurst] = useState("");
  const [methods, setMethods] = useState("");
  const [banIps, setBanIps] = useState("");
  const [banCountries, setBanCountries] = useState("");
  const [allowCountries, setAllowCountries] = useState("");
  const [denyCidrs, setDenyCidrs] = useState("");
  const [banUserAgents, setBanUserAgents] = useState("");
  const [blockEmptyUA, setBlockEmptyUA] = useState(false);
  const [allowReferers, setAllowReferers] = useState("");
  const [blockStatus, setBlockStatus] = useState("403");

  const load = useCallback(async () => {
    if (!projectData?.id) return;
    setLoading(true);
    try {
      const res = await projectsApi.listRouteRules(projectData.id);
      const list = res?.rules ?? [];
      setRules(list);
      if (!autoOpened.current && list.length > 0) {
        setOpen(true);
        autoOpened.current = true;
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, w.loadFailed), "error", w.title);
    } finally {
      setLoading(false);
    }
  }, [projectData?.id, showToast, w.loadFailed, w.title]);

  useEffect(() => {
    void load();
  }, [load]);

  const buildSpec = (): RouteRuleSpec => {
    const spec: RouteRuleSpec = {};

    const rpsN = Number(rps);
    if (Number.isFinite(rpsN) && rpsN > 0) {
      const burstN = Number(burst);
      spec.rateLimit = {
        rps: Math.floor(rpsN),
        burst: Number.isFinite(burstN) && burstN >= 0 ? Math.floor(burstN) : 0,
      };
    }

    const ban: NonNullable<RouteRuleSpec["ban"]> = {};
    const ips = tokens(banIps);
    if (ips.length) {
      const cidrs = ips.filter((s) => s.includes("/"));
      const bare = ips.filter((s) => !s.includes("/"));
      if (bare.length) ban.ips = bare;
      if (cidrs.length) ban.cidrs = cidrs;
    }
    const bCountries = tokens(banCountries).map((c) => c.toUpperCase().slice(0, 2));
    if (bCountries.length) ban.countries = bCountries;
    const uas = commaList(banUserAgents);
    if (uas.length) ban.userAgents = uas;
    if (blockEmptyUA) ban.emptyUserAgent = true;
    if (Object.keys(ban).length) spec.ban = ban;

    const access: NonNullable<RouteRuleSpec["access"]> = {};
    const deny = tokens(denyCidrs);
    const allowCC = tokens(allowCountries).map((c) => c.toUpperCase().slice(0, 2));
    const allowedMethods = tokens(methods).map((m) => m.toUpperCase());
    if (deny.length) access.denyCidrs = deny;
    if (allowCC.length) access.allowCountries = allowCC;
    if (allowedMethods.length) access.methods = allowedMethods;
    if (Object.keys(access).length) spec.access = access;

    const referers = tokens(allowReferers).map((h) => h.toLowerCase());
    if (referers.length) spec.hotlink = { allowReferers: referers };

    const bs = Number(blockStatus);
    if (Number.isFinite(bs) && bs !== 403) spec.block = { status: bs };

    return spec;
  };

  const canAdd = () =>
    Number(rps) > 0 ||
    tokens(methods).length > 0 ||
    tokens(banIps).length > 0 ||
    tokens(banCountries).length > 0 ||
    tokens(allowCountries).length > 0 ||
    tokens(denyCidrs).length > 0 ||
    commaList(banUserAgents).length > 0 ||
    tokens(allowReferers).length > 0 ||
    blockEmptyUA;

  const resetForm = () => {
    setPathPrefix(""); setRps(""); setBurst(""); setMethods("");
    setBanIps(""); setBanCountries(""); setAllowCountries(""); setDenyCidrs("");
    setBanUserAgents(""); setBlockEmptyUA(false); setAllowReferers(""); setBlockStatus("403");
  };

  const handleAdd = async () => {
    if (!projectData?.id || saving || !canAdd()) return;
    setSaving(true);
    try {
      await projectsApi.createRouteRule(projectData.id, {
        domainId: null, // project-wide (all hostnames) for now
        pathPrefix: pathPrefix.trim() || null,
        spec: buildSpec(),
        enabled: true,
      });
      resetForm();
      await load();
      showToast(w.saved, "success", w.title);
    } catch (err) {
      showToast(getApiErrorMessage(err, w.saveFailed), "error", w.title);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: RouteRuleRow) => {
    setBusyId(rule.id);
    try {
      await projectsApi.updateRouteRule(projectData.id, rule.id, { enabled: !rule.enabled });
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, w.saveFailed), "error", w.title);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (rule: RouteRuleRow) => {
    setBusyId(rule.id);
    try {
      await projectsApi.deleteRouteRule(projectData.id, rule.id);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, w.saveFailed), "error", w.title);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      {/* Header doubles as the collapse toggle — matches the routing card so both
          edge-config sections sit collapsed together in the Domains tab. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-start transition-colors hover:bg-muted/20"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
            <UiIcon name="shield" className="size-[18px]" />
          </div>
          <div className="text-start">
            <h3 className="text-[14px] font-semibold text-foreground">{w.title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{w.description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {rules.length > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {rules.length}
            </span>
          )}
          <UiIcon name="chevron-down" className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open && (
      <div className="space-y-4 border-t border-border/40 px-5 py-4">
        {/* Existing rules */}
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <UiIcon name="spinner" className="size-4 animate-spin" /> {w.loading}
          </div>
        ) : rules.length === 0 ? (
          <p className="py-1 text-[13px] text-muted-foreground">{w.empty}</p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {rule.pathPrefix ? rule.pathPrefix : w.allPaths}
                    <span className="ms-2 text-[12px] font-normal text-muted-foreground">{w.allHosts}</span>
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground">{summarize(rule.spec)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle(rule)}
                  disabled={busyId === rule.id}
                  className={`shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                    rule.enabled ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {rule.enabled ? w.enabled : w.disabled}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(rule)}
                  disabled={busyId === rule.id}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
                >
                  {busyId === rule.id ? <UiIcon name="spinner" className="size-3.5 animate-spin" /> : <UiIcon name="trash" className="size-3.5" />}
                  {w.remove}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add rule */}
        <div className="rounded-xl border border-dashed border-border/60 p-4">
          <p className="mb-3 text-[13px] font-medium text-foreground">{w.addTitle}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={w.pathLabel}>
              <input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/api" className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={w.rps}>
                <input value={rps} onChange={(e) => setRps(e.target.value)} inputMode="numeric" placeholder="10" className={inputCls} />
              </Field>
              <Field label={w.burst}>
                <input value={burst} onChange={(e) => setBurst(e.target.value)} inputMode="numeric" placeholder="20" className={inputCls} />
              </Field>
            </div>
            <Field label={w.methods}>
              <input value={methods} onChange={(e) => setMethods(e.target.value)} placeholder="GET, POST" className={inputCls} />
            </Field>
            <Field label={w.banIps}>
              <input value={banIps} onChange={(e) => setBanIps(e.target.value)} placeholder="1.2.3.4, 10.0.0.0/8" className={inputCls} />
            </Field>
            <Field label={w.banCountries}>
              <input value={banCountries} onChange={(e) => setBanCountries(e.target.value)} placeholder="RU, CN" className={inputCls} />
            </Field>
            <Field label={w.allowCountries}>
              <input value={allowCountries} onChange={(e) => setAllowCountries(e.target.value)} placeholder="US, CA, GB" className={inputCls} />
            </Field>
            <Field label={w.denyCidrs}>
              <input value={denyCidrs} onChange={(e) => setDenyCidrs(e.target.value)} placeholder="203.0.113.0/24" className={inputCls} />
            </Field>
            <Field label={w.allowReferers}>
              <input value={allowReferers} onChange={(e) => setAllowReferers(e.target.value)} placeholder="example.com" className={inputCls} />
            </Field>
            <Field label={w.banUserAgents}>
              <input value={banUserAgents} onChange={(e) => setBanUserAgents(e.target.value)} placeholder="curl, python-requests" className={inputCls} />
            </Field>
            <Field label={w.blockStatus}>
              <select value={blockStatus} onChange={(e) => setBlockStatus(e.target.value)} className={inputCls}>
                <option value="403">403</option>
                <option value="404">404</option>
                <option value="429">429</option>
                <option value="444">444</option>
                <option value="451">451</option>
                <option value="503">503</option>
              </select>
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-[13px] text-foreground">
            <input type="checkbox" checked={blockEmptyUA} onChange={(e) => setBlockEmptyUA(e.target.checked)} className="size-4 rounded border-border/60" />
            {w.blockEmptyUa}
          </label>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !canAdd()}
            className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <UiIcon name="spinner" className="size-3.5 animate-spin" /> : <UiIcon name="plus" className="size-3.5" />}
            {w.add}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

const inputCls =
  "h-9 w-full rounded-lg border border-border/50 bg-background px-3 text-[13px] text-foreground outline-none focus:border-primary/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
