"use client";

/**
 * Right column: the authoritative statement of what Authorize will grant.
 *
 * It STATES the access level and lets you drop a grant (or a whole type) — it does
 * not set levels. That belongs to the editor on the left, and keeping it there is
 * what leaves this header room for a real type label instead of "GITHUB…", and
 * stops one decision from being asked once per row.
 *
 * Also the honesty budget: `capabilityDigest` turns the grant tuples into a
 * "Will be able to / Will not be able to" list, because "github_installation /
 * acme · read" is not something a user can consent to meaningfully.
 */

import { useMemo } from "react";
import { AlertCircle, Check, Info, Lock, PlusCircle, ShieldCheck, X } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import {
  authorizeBlockedReason,
  capabilityDigest,
  isUnscopedTemplate,
  readOnlyContradictions,
  summaryGroups,
  summaryRows,
  wireGrants,
  type AccessLevel,
  type AccessSelection,
  type DigestKey,
  type SummaryGroup,
} from "@/components/permissions/mcp-access-templates";
import { ResourceAvatar } from "@/components/permissions/ResourceAvatar";
import { resourceTypeLabel, type ResourceType } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";

export function ScopeSummary({
  selection,
  orgName,
  labels,
  disabled,
  onRemove,
  onRemoveType,
  onReadOnly,
}: {
  selection: AccessSelection;
  orgName: string;
  labels: ReadonlyMap<string, string>;
  disabled?: boolean;
  onRemove: (resourceType: ResourceType, resourceId: string) => void;
  onRemoveType: (resourceType: ResourceType) => void;
  onReadOnly: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;

  const unscoped = isUnscopedTemplate(selection.template);
  const rows = unscoped ? [] : summaryRows(wireGrants(selection), labels);
  const groups = useMemo(() => summaryGroups(rows), [rows]);
  const blocked = authorizeBlockedReason(selection);
  const conflicts = readOnlyContradictions(selection);
  const digest = capabilityDigest(selection);

  const digestText = (key: DigestKey): string => {
    const map: Record<DigestKey, string> = {
      createProjects: interpolate(m.dgCreateProjects, { org: orgName }),
      manageOwnProjects: m.dgManageOwnProjects,
      operatePickedProjects: m.dgOperatePickedProjects,
      viewPickedProjects: m.dgViewPickedProjects,
      readGithub: m.dgReadGithub,
      readSource: m.dgReadSource,
      notReadSource: m.dgNotReadSource,
      writeGithub: m.dgWriteGithub,
      servers: m.dgServers,
      backups: m.dgBackups,
      everything: interpolate(m.dgEverything, { org: orgName }),
      readEverything: interpolate(m.dgReadEverything, { org: orgName }),
      notExistingProjects: m.dgNotExistingProjects,
      notEnumerateProjects: m.dgNotEnumerateProjects,
      notServers: m.dgNotServers,
      notDelete: m.dgNotDelete,
      noWrites: m.dgNoWrites,
    };
    return map[key];
  };

  return (
    <div className="rounded-2xl bg-card p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground/70" />
        <h2 className="text-[14px] font-medium text-foreground">{m.summaryHeading}</h2>
        {!unscoped && rows.length > 0 && (
          <span className="ms-auto text-[11px] font-medium text-muted-foreground">
            {interpolate(rows.length === 1 ? m.grantCountOne : m.grantCountOther, {
              count: String(rows.length),
            })}
          </span>
        )}
      </div>

      {/* ── The scope itself ── */}
      {unscoped ? (
        <UnscopedBlock
          readOnly={selection.readOnly}
          title={
            selection.readOnly
              ? interpolate(m.summaryReadOnlyTitle, { org: orgName })
              : interpolate(m.summaryUnscopedTitle, { org: orgName })
          }
          body={selection.readOnly ? m.summaryReadOnlyBody : m.summaryUnscopedBody}
        />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border/50 px-4 py-6 text-center">
          <p className="text-sm font-medium text-foreground">{m.summaryEmptyTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">{m.summaryEmptyBody}</p>
        </div>
      ) : (
        // Deliberately NOT independently scrollable. The rail as a whole scrolls
        // (see RailScroll) with the buttons pinned outside it — one scroll region,
        // not two, because the global `::-webkit-scrollbar { display: none }`
        // makes a nested scroller invisible and easy to get lost in.
        <div className="divide-y divide-border/30 overflow-hidden rounded-xl border border-border/50">
          {groups.map((group) => (
            <SummaryGroupBlock
              key={group.resourceType ?? "capability"}
              group={group}
              disabled={disabled}
              onRemove={onRemove}
              onRemoveType={onRemoveType}
            />
          ))}
        </div>
      )}

      {/* ── Plain-language digest ──
          Suppressed while a scoped selection is empty: the empty-state card above
          already says "nothing granted yet", and a bare "Will not be able to…"
          list under it reads like a list of denials rather than an empty scope. */}
      <div className={unscoped || rows.length > 0 ? "mt-4 space-y-3" : "hidden"}>
        {digest.can.length > 0 && (
          <DigestList
            heading={m.canHeading}
            tone="can"
            items={digest.can.map(digestText)}
          />
        )}
        {digest.cannot.length > 0 && (
          <DigestList
            heading={m.cannotHeading}
            tone="cannot"
            items={digest.cannot.map(digestText)}
          />
        )}
      </div>

      {/* ── Read-only modifier ── */}
      <div className="mt-4 border-t border-border/50 pt-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Lock className="size-3.5 text-muted-foreground" />
              {m.readOnly}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.readOnlyDesc}</p>
          </div>
          <div className="mt-0.5 shrink-0">
            <Switch
              checked={selection.readOnly}
              onChange={onReadOnly}
              disabled={disabled}
              ariaLabel={m.readOnly}
            />
          </div>
        </div>

        {selection.readOnly && (
          <p className="mt-2.5 flex items-start gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{m.readOnlySecretsNote}</span>
          </p>
        )}

        {/* Read-only is an HTTP-method gate, so it silently voids anything
            write-shaped. Say so, with the fix one click away. */}
        {(conflicts.create || conflicts.writes > 0) && (
          <div className="mt-2.5 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-xs text-warning">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 space-y-1">
                {conflicts.create && <p>{m.readOnlyConflictCreate}</p>}
                {conflicts.writes > 0 && (
                  <p>
                    {interpolate(
                      conflicts.writes === 1 ? m.readOnlyConflictWritesOne : m.readOnlyConflictWritesOther,
                      { count: String(conflicts.writes) },
                    )}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onReadOnly(false)}
              disabled={disabled}
              className="mt-2 font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50"
            >
              {m.turnOffReadOnly}
            </button>
          </div>
        )}
      </div>

      {/* ── Why Authorize is disabled ── */}
      {blocked && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-xs text-warning">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{blocked === "noResources" ? m.blockedNoResources : m.blockedNoPermissions}</span>
        </div>
      )}
    </div>
  );
}

function UnscopedBlock({
  readOnly,
  title,
  body,
}: {
  readOnly: boolean;
  title: string;
  body: string;
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3.5 ${
        readOnly ? "border-info-border bg-info-bg" : "border-warning-border bg-warning-bg"
      }`}
    >
      <p className={`flex items-start gap-2 text-sm font-medium ${readOnly ? "text-info" : "text-warning"}`}>
        {readOnly ? (
          <Lock className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        )}
        <span>{title}</span>
      </p>
      <p className={`mt-1.5 ps-5 text-xs leading-relaxed ${readOnly ? "text-info/80" : "text-warning/80"}`}>
        {body}
      </p>
    </div>
  );
}

function SummaryGroupBlock({
  group,
  disabled,
  onRemove,
  onRemoveType,
}: {
  group: SummaryGroup;
  disabled?: boolean;
  onRemove: (resourceType: ResourceType, resourceId: string) => void;
  onRemoveType: (resourceType: ResourceType) => void;
}) {
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;

  // The capability bucket has no level to set — "create" is collection-only and
  // must stay exactly ["create"] or the mint 400s.
  if (group.resourceType === null) {
    return (
      <>
        {group.rows.map((row) => (
          <div key={row.resourceId} className="flex items-start gap-2.5 bg-primary/[0.04] px-3.5 py-3">
            <PlusCircle className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{m.capabilityRowTitle}</p>
              <p className="text-xs text-muted-foreground">{m.capabilityRowDesc}</p>
            </div>
            <RemoveButton
              onClick={() => onRemove(row.resourceType, row.resourceId)}
              disabled={disabled}
              label={m.removeGrant}
            />
          </div>
        ))}
      </>
    );
  }

  const type = group.resourceType;
  const many = group.rows.length > 1;

  return (
    <div>
      {/* One header per type. The level is STATED, not set — changing it happens
          in the editor on the left, which is also why the header has room for the
          full type label instead of truncating to "GITHUB…". */}
      <div className="flex items-center gap-2 bg-muted/20 px-3.5 py-2">
        <p className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {resourceTypeLabel(type)}
          {many && <span className="ms-1.5 font-normal normal-case tracking-normal">{group.rows.length}</span>}
        </p>
        {/* When every row agrees — what the presets produce — say the level once
            here rather than repeating it down every row. */}
        {group.sharedLevel && <LevelTag level={group.sharedLevel} />}
        {many && (
          <RemoveButton onClick={() => onRemoveType(type)} disabled={disabled} label={m.removeGrant} />
        )}
      </div>

      {/* Pills that WRAP rather than one row each. Five GitHub accounts fit on
          two lines instead of five, which is the difference between the digest
          and the Authorize button being on screen or not. */}
      <div className="flex flex-wrap gap-1.5 px-3.5 pb-2.5 pt-0.5">
        {group.rows.map((row) => (
          <span
            key={row.resourceId}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/25 py-0.5 pe-1 ps-1.5"
          >
            <ResourceAvatar resourceType={type} resourceId={row.resourceId} className="size-4" />
            <span className="min-w-0 truncate text-[11px] text-foreground" title={row.label}>
              {row.wildcard ? `${m.wildcardTag} ${resourceTypeLabel(type).toLowerCase()}` : row.label}
            </span>
            {/* Only when the group's levels diverge — otherwise the header said it. */}
            {!group.sharedLevel && <LevelTag level={row.level} />}
            <RemoveButton
              onClick={() => onRemove(type, row.resourceId)}
              disabled={disabled}
              label={m.removeGrant}
              compact
            />
          </span>
        ))}
      </div>
    </div>
  );
}

/** The level a grant carries, as a read-only tag. */
function LevelTag({ level }: { level: AccessLevel }) {
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;
  const label: Record<AccessLevel, string> = {
    view: m.levelView,
    manage: m.levelManage,
    full: m.levelFull,
  };
  return (
    <span className="shrink-0 rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {label[level]}
    </span>
  );
}

function RemoveButton({
  onClick,
  disabled,
  label,
  compact,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  /** Sits inside a pill — needs to not dominate it. */
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`shrink-0 rounded-full text-muted-foreground/60 transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-40 ${
        compact ? "p-0.5" : "p-1"
      }`}
    >
      <X className={compact ? "size-3" : "size-3.5"} />
    </button>
  );
}

function DigestList({
  heading,
  tone,
  items,
}: {
  heading: string;
  tone: "can" | "cannot";
  items: string[];
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {heading}
      </p>
      <ul className="space-y-1">
        {items.map((text) => (
          <li key={text} className="flex items-start gap-2 text-xs leading-relaxed">
            {tone === "can" ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : (
              <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            <span className={tone === "can" ? "text-foreground/80" : "text-muted-foreground"}>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
