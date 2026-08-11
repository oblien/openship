"use client";

/**
 * THE access editor. One component for every surface that decides what something
 * may reach: the MCP consent screen, the MCP tab's "edit access", personal access
 * token creation, and member grants.
 *
 * ── Why one ─────────────────────────────────────────────────────────────────
 * There used to be three separate experiences over the same `ResourcePicker`. The
 * consent screen had templates, named access levels, a capability digest and
 * read-only conflict warnings; `GrantPickerModal` (tokens + members) had raw
 * read/write/admin chips and none of the rest. They also disagreed about the facts:
 * the token screen offered resource types the consent screen deliberately withheld,
 * and it omitted `suppressWildcardTypes`, so it could build an "All projects ·
 * read/write" grant that the mint rejects with 400 every single time.
 *
 * ── Why it owns no reducer ──────────────────────────────────────────────────
 * `selection` and `dispatch` are CONTROLLED, and that is a safety property, not a
 * style choice. The MCP tab edits an EXISTING scope, and saving replaces grants
 * wholesale with no diff — so an editor that could default its own state would
 * overwrite whatever the user had. Note the dangerous default is not an empty one
 * (the server rejects zero grants without an explicit `fullAccess`); it is the
 * consent screen's `templateGrants("agent", ctx)`, which is non-empty and valid and
 * would sail through every guard while silently replacing the user's scope with the
 * coding-agent preset. Making the caller hold the reducer means the seed is always
 * a visible decision at the call site.
 */

import type { ReactNode } from "react";
import type { CatalogEntry, PickerGrant, ResourceType } from "@/lib/api";
import { AccessTemplateCards } from "./AccessTemplateCards";
import { AccessScopeEditor } from "./AccessScopeEditor";
import { AccessScopeSummary } from "./AccessScopeSummary";
import { RailScroll } from "./RailScroll";
import {
  isUnscopedTemplate,
  type AccessSelection,
  type ScopeAction,
  type TemplateContext,
} from "./mcp-access-templates";

export interface AccessControlEditorProps {
  /** CONTROLLED — see the header. The caller owns the reducer. */
  selection: AccessSelection;
  dispatch: (action: ScopeAction) => void;
  /** Mode-filtered by the caller (`grantableTypesForMode`, or the member set). */
  availableTypes: ResourceType[];
  /** Resolves what a template stands for. Seeded from GET /api/github/home. */
  ctx: TemplateContext;
  /** Remounts the picker on an org switch so no catalog row outlives its org. */
  orgKey: string;
  /** Interpolated into the shared copy — the org a grant will be written in. */
  orgName: string;
  /**
   * Catalog id → display label, so the summary shows "storefront" and not a cuid.
   * Threaded through to the picker's `onCatalogLoaded`: the consent page built this
   * map and never passed it down, which is why its summary showed raw ids.
   */
  labels?: ReadonlyMap<string, string>;
  onCatalogLoaded?: (type: ResourceType, entries: CatalogEntry[]) => void;
  /**
   * Which halves to render. Member grants turn all three off: "unscoped member" is
   * meaningless, `readOnly` is a token property, and the grants API's permission
   * whitelist has no `create`, so the create switch would offer a no-op.
   */
  show?: { templates?: boolean; readOnlySwitch?: boolean; createCapability?: boolean };
  /**
   * Defaults to `["project"]`. Every TOKEN consumer needs it — the mint refuses any
   * non-create `{project,"*"}` grant — while member grants pass `[]` to keep the
   * legitimate "All projects" row.
   */
  suppressWildcardTypes?: ResourceType[];
  layout?: "two-column" | "stacked";
  /** The caller's own action bar. Verbs differ per surface; the nouns above do not. */
  footer?: ReactNode;
  /** Rendered under the summary — 403 recovery, save errors, surface-specific notes. */
  notice?: ReactNode;
  disabled?: boolean;
}

export function AccessControlEditor({
  selection,
  dispatch,
  availableTypes,
  ctx,
  orgKey,
  orgName,
  labels,
  onCatalogLoaded,
  show,
  suppressWildcardTypes = ["project"],
  layout = "two-column",
  footer,
  notice,
  disabled,
}: AccessControlEditorProps) {
  const showTemplates = show?.templates ?? true;
  const showReadOnly = show?.readOnlySwitch ?? true;
  const showCreate = show?.createCapability ?? true;
  const scoped = !isUnscopedTemplate(selection.template);

  const left = (
    <div className="space-y-4">
      {showTemplates && (
        <AccessTemplateCards
          active={selection.template}
          orgName={orgName}
          disabled={disabled}
          onPick={(id) => dispatch({ type: "pickTemplate", id })}
          onReset={() => dispatch({ type: "pickTemplate", id: "agent" })}
        />
      )}
      {/* An unscoped selection has nothing to edit — its whole meaning is "no
          limits", so a resource picker under it would imply otherwise. */}
      {scoped && (
        <AccessScopeEditor
          selection={selection}
          availableTypes={availableTypes}
          orgKey={orgKey}
          disabled={disabled}
          showCreateCapability={showCreate}
          onCatalogLoaded={onCatalogLoaded}
          suppressWildcardTypes={suppressWildcardTypes}
          onPickerChange={(grants) => dispatch({ type: "pickerChange", grants })}
          onCreateChange={(on) => dispatch({ type: "setCreate", on })}
        />
      )}
    </div>
  );

  const right = (
    <>
      <AccessScopeSummary
        selection={selection}
        orgName={orgName}
        labels={labels ?? new Map()}
        disabled={disabled}
        showReadOnly={showReadOnly}
        onRemove={(resourceType, resourceId) =>
          dispatch({ type: "removeGrant", resourceType, resourceId })
        }
        onRemoveType={(resourceType) => dispatch({ type: "removeType", resourceType })}
        onReadOnly={(on) => dispatch({ type: "setReadOnly", on })}
      />
      {notice}
    </>
  );

  if (layout === "stacked") {
    return (
      <div className="space-y-4">
        {left}
        {right}
        {footer}
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {left}
      <div className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)]">
        <RailScroll>{right}</RailScroll>
        {footer}
      </div>
    </div>
  );
}
