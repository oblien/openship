"use client";

/**
 * Project Routing/Domains tab card: view + edit the vercel.json-derived routing
 * (rewrites/redirects/headers). Saving PATCHes the project; the backend re-applies
 * it to the live deployment's OpenResty WITHOUT a rebuild (self-hosted). Wraps the
 * shared RoutingConfigEditor (same editor the wizard uses).
 */

import React, { useCallback, useEffect, useState } from "react";
import { Route, ChevronDown } from "lucide-react";
import type { RoutingConfig } from "@repo/core";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import type { EdgeConfigReport } from "@/lib/api/projects";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { RoutingConfigEditor } from "@/components/routing/RoutingConfigEditor";

/** Any actual routing rules configured? Governs whether the card opens by
 *  default — an empty vercel.json routing block stays collapsed so it doesn't
 *  dominate the tab; a project that uses routing shows its rules up front. */
function hasRoutingRules(cfg: RoutingConfig | null | undefined): boolean {
  if (!cfg) return false;
  return Boolean(
    cfg.rewrites?.length ||
      cfg.redirects?.length ||
      cfg.headers?.length ||
      cfg.cleanUrls ||
      cfg.trailingSlash ||
      // A project whose only routing config is a raised upload limit still has
      // something to show — otherwise the setting hides behind two collapses.
      (cfg.proxy && Object.keys(cfg.proxy).length > 0),
  );
}

export function RoutingConfigCard({
  id,
  initial,
  onSaved,
}: {
  id: string;
  initial: RoutingConfig | null | undefined;
  onSaved?: (cfg: RoutingConfig | null) => void;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [draft, setDraft] = useState<RoutingConfig | null>(initial ?? null);
  const [saving, setSaving] = useState(false);
  // Collapsed by default; auto-open when the project actually has rules.
  const [open, setOpen] = useState(() => hasRoutingRules(initial));
  const [edge, setEdge] = useState<EdgeConfigReport | null>(null);
  const [edgeLoading, setEdgeLoading] = useState(false);

  /** Read what the edge is actually serving. On-demand (not part of the project
   *  read) because it SSHes to the box and parses its vhosts. */
  const loadEdge = useCallback(async () => {
    setEdgeLoading(true);
    try {
      setEdge(await projectsApi.getEdgeConfig(id));
    } catch {
      // A box we can't read is not an error worth a toast — the panel says so.
      setEdge({ reachable: false, saved: {}, hosts: [] });
    } finally {
      setEdgeLoading(false);
    }
  }, [id]);

  // Only once the card is open: nobody needs an SSH round-trip for a collapsed card.
  useEffect(() => {
    if (open && !edge && !edgeLoading) void loadEdge();
  }, [open, edge, edgeLoading, loadEdge]);

  const save = async () => {
    setSaving(true);
    try {
      await projectsApi.update(id, { routingConfig: draft });
      onSaved?.(draft);
      invalidateProjectCaches(id);
      // Re-read: the save re-applies the vhosts, so the live column and any drift
      // badge must reflect the write that just happened, not the state before it.
      void loadEdge();
      showToast(t.projectSettings.routing.toast.updated, "success", t.projectSettings.routing.toast.title);
    } catch (err) {
      showToast(getApiErrorMessage(err) || t.projectSettings.routing.toast.failed, "error", t.projectSettings.routing.toast.title);
    } finally {
      setSaving(false);
    }
  };

  const active = hasRoutingRules(draft);

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      {/* Header doubles as the collapse toggle — the editor is advanced/optional
          so it stays tucked away until opened (or auto-opened when rules exist). */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-start transition-colors hover:bg-muted/20"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
            <Route className="size-[18px]" />
          </div>
          <div>
            <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.routing.title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {t.projectSettings.routing.description}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[12px] text-muted-foreground">
            {active ? t.projectSettings.routing.summaryActive : t.projectSettings.routing.summaryNone}
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      {open && (
        <div className="border-t border-border/40 px-5 py-4">
          <RoutingConfigEditor
            value={draft}
            onChange={setDraft}
            disabled={saving}
            showProxySettings
            edgeConfig={edge}
            onRefreshEdgeConfig={loadEdge}
            edgeConfigLoading={edgeLoading}
          />
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? t.projectSettings.routing.saving : t.projectSettings.routing.save}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default RoutingConfigCard;
