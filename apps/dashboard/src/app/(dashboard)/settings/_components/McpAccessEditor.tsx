"use client";

/**
 * Edit a CONNECTED agent's access, from the settings MCP tab.
 *
 * Re-scoping needs no new endpoint: `POST /api/tokens/mcp-authorize` upserts the
 * binding on (userId, clientId) with a stable row id, so an issued OAuth token keeps
 * resolving to it and the new scope applies on the agent's very next request — no
 * reconnect, no re-consent. What it does NOT do is diff: it replaces the grants
 * wholesale.
 *
 * That single fact drives this whole component's shape. Five layers stand between a
 * mis-click and a wiped scope:
 *
 *   1. FETCH BEFORE OPEN. The caller resolves `GET /mcp-clients/:id` before rendering
 *      this at all, so the failure mode is "the panel never opened" (visible) rather
 *      than "the panel opened empty" (not).
 *   2. The reducer is seeded from that response and lives HERE, not inside
 *      `AccessControlEditor`. The dangerous default was never an empty selection —
 *      the server rejects zero grants without an explicit `fullAccess` — it was the
 *      consent screen's `templateGrants("agent")`, which is non-empty and valid and
 *      would sail through every guard while replacing the user's scope with the
 *      coding-agent preset.
 *   3. `authorizeBlockedReason` disables Save for a scoped selection with nothing
 *      live in it, and `wouldSilentlyGrantEverything` is the belt at submit. Both
 *      come free with the shared editor — the concrete argument for reusing it.
 *   4. The server's `resolveScopeIntent` 400s zero-grants-without-fullAccess.
 *   5. Widening to unscoped needs `confirmWiden`, enforced server-side so a script
 *      gets the same gate this dialog does.
 */

import { useCallback, useMemo, useReducer, useState } from "react";
import { AlertCircle, Loader2, ShieldAlert } from "lucide-react";
import { grantableTypesForMode } from "@repo/core";
import { AccessControlEditor } from "@/components/permissions/AccessControlEditor";
import {
  authorizeBlockedReason,
  dropRejectedGrant,
  isUnscopedTemplate,
  reduceSelection,
  wireGrants,
  wouldSilentlyGrantEverything,
  type AccessSelection,
  type ScopeAction,
  type TemplateContext,
} from "@/components/permissions/mcp-access-templates";
import {
  getApiErrorMessage,
  resourceTypeLabel,
  tokensApi,
  type CatalogEntry,
  type McpClientDetail,
  type ResourceType,
} from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";

/**
 * Unscoped-ness is STORED INTENT, never inferred from `grants.length`.
 *
 * A scoped binding starts at "custom" rather than being matched back to a preset:
 * its grants came from the server, so naming a preset they might not match would be
 * a lie in the UI. `relabel` promotes it to a preset on the first edit if it really
 * does match — which is the behaviour that module was built for.
 */
export function selectionFromDetail(detail: McpClientDetail): AccessSelection {
  return {
    grants: detail.grants,
    readOnly: detail.readOnly,
    template: detail.scoped ? "custom" : detail.readOnly ? "readOnly" : "full",
  };
}

export function McpAccessEditor({
  detail,
  onClose,
  onSaved,
}: {
  detail: McpClientDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const m = t.settings.mcp;
  const { selfHosted } = usePlatform();
  const { showToast } = useToast();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  /** Set once the server has told us this widening needs confirming. */
  const [widenPending, setWidenPending] = useState(false);
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());

  // Templates resolve against the live catalog; there is no GitHub seed to fetch
  // here because we are EDITING a stored selection, not building a preset from
  // scratch. A user who picks "Coding agent" gets the create capability and whatever
  // GitHub grants they then choose explicitly.
  const ctx = useMemo<TemplateContext>(() => ({ githubAccounts: [] }), []);
  const [selection, dispatch] = useReducer(
    (state: AccessSelection, action: ScopeAction) => reduceSelection(state, action, ctx),
    detail,
    selectionFromDetail,
  );

  const availableTypes: ResourceType[] = useMemo(
    () => grantableTypesForMode(selfHosted),
    [selfHosted],
  );

  const onCatalogLoaded = useCallback((type: ResourceType, entries: CatalogEntry[]) => {
    setLabels((prev) => {
      const next = new Map(prev);
      for (const e of entries) next.set(`${type} ${e.id}`, e.label);
      return next;
    });
  }, []);

  const scoped = !isUnscopedTemplate(selection.template);
  const wasScoped = detail.scoped && detail.grants.length > 0;
  const wouldWiden = wasScoped && !scoped;
  const blocked = authorizeBlockedReason(selection) !== null;

  const save = useCallback(
    async (confirmWiden: boolean) => {
      setError(null);
      setRejected(null);
      if (wouldSilentlyGrantEverything(selection)) {
        setError(m.scopeSaveFailed);
        return;
      }
      setSaving(true);
      try {
        await tokensApi.mcpAuthorize({
          mode: "edit",
          clientId: detail.clientId ?? "",
          readOnly: selection.readOnly,
          grants: wireGrants(selection),
          fullAccess: isUnscopedTemplate(selection.template),
          // The binding's own org. An edit may not re-bind — the server refuses it,
          // because every resource id in this panel was picked from that org.
          organizationId: detail.organizationId ?? undefined,
          ...(confirmWiden ? { confirmWiden: true } : {}),
        });
        showToast(m.scopeSaved, "success");
        onSaved();
      } catch (err) {
        const code = (err as { body?: { code?: string } }).body?.code;
        const status = (err as { status?: number }).status;

        // The server gates widening, so the dialog learns about it from the refusal
        // rather than duplicating the rule. Second press sends the confirmation.
        if (code === "SCOPE_WIDEN_NOT_CONFIRMED") {
          setWidenPending(true);
          setSaving(false);
          return;
        }

        // 403 GRANT_EXCEEDS_ACCESS names the grant the user can no longer re-grant.
        // MORE likely here than at consent: their own access can have SHRUNK since
        // the agent was connected, so a grant that was valid then may not be now.
        const recovery =
          status === 403 ? dropRejectedGrant(selection.grants, getApiErrorMessage(err, "")) : null;
        if (recovery) {
          dispatch({
            type: "removeGrant",
            resourceType: recovery.dropped.resourceType,
            resourceId: recovery.dropped.resourceId,
          });
          setRejected(
            `${resourceTypeLabel(recovery.dropped.resourceType)} · ${recovery.dropped.resourceId}`,
          );
          setSaving(false);
          return;
        }

        setError(getApiErrorMessage(err, m.scopeSaveFailed));
        setSaving(false);
      }
    },
    [selection, detail, m, showToast, onSaved],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-medium text-foreground">
          {interpolate(m.editScopeTitle, { client: detail.name })}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {m.editScopeSubtitle}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {/* The org is stated, not editable — see the ORG_REBIND_NOT_ALLOWED guard. */}
          {detail.organizationName
            ? interpolate(m.editScopeOrg, { org: detail.organizationName })
            : null}
          {/* One number that makes an accidental wipe visible BEFORE Save. */}
          {wasScoped
            ? ` · ${interpolate(
                detail.grants.length === 1 ? m.wasNResourcesOne : m.wasNResourcesMany,
                { count: String(detail.grants.length) },
              )}`
            : ""}
        </p>
      </div>

      <AccessControlEditor
        selection={selection}
        dispatch={dispatch}
        availableTypes={availableTypes}
        ctx={ctx}
        orgKey={detail.organizationId ?? "none"}
        orgName={detail.organizationName ?? ""}
        labels={labels}
        onCatalogLoaded={onCatalogLoaded}
        layout="stacked"
        disabled={saving}
        notice={
          <>
            {rejected && (
              <div className="rounded-xl border border-warning-border bg-warning-bg p-3.5 text-xs text-warning">
                <p className="flex items-start gap-2 font-medium">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  {interpolate(m.scopeGrantRejected, { resource: rejected })}
                </p>
              </div>
            )}
            {widenPending && (
              <div className="rounded-xl border border-warning-border bg-warning-bg p-3.5 text-xs text-warning">
                <p className="flex items-start gap-2 font-medium">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                  {m.confirmWidenTitle}
                </p>
                <p className="mt-1 ps-5 leading-relaxed">{m.confirmWidenBody}</p>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm text-danger">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </div>
            )}
          </>
        }
        footer={
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t.settings.common.cancel}
            </button>
            <button
              type="button"
              onClick={() => void save(widenPending)}
              disabled={saving || blocked}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                widenPending || wouldWiden
                  ? "bg-danger-solid hover:bg-danger-solid/90"
                  : "bg-primary hover:bg-primary/90"
              }`}
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {widenPending ? m.confirmWidenAction : m.saveScope}
            </button>
          </div>
        }
      />
    </div>
  );
}
