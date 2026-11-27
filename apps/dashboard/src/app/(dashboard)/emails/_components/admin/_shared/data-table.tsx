"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * Proper data table for admin lists (Domains, Mailboxes, Aliases, etc.).
 *
 * Replaces the per-row chunky-card pattern. Mail-admin lists can grow
 * past 50 rows easily and need to scan fast - a real table layout with
 * a header row, dense bodies, and clean separators is the right shape
 * for that.
 *
 * Built with divs + CSS grid (not <table>) so columns stay aligned
 * between header and body without table layout quirks, and so each row
 * can use the full Tailwind hover/active toolkit.
 *
 * The caller declares columns once; the table handles header rendering,
 * column widths, hover state, empty state, loading skeletons, and an
 * optional right-side actions column. No tanstack dependency.
 */

import { cn } from "@/lib/utils";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { Skeleton } from "./skeleton";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  skeleton?: React.ReactNode;
  /** CSS grid-template column value: `1fr`, `200px`, `minmax(160px, 1fr)`, etc. */
  width: string;
  align?: "left" | "right" | "center";
  /** Secondary columns can respond to the viewport or the table's available width. */
  hideBelow?: "sm" | "md" | "lg" | "table-sm" | "table-md";
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Show skeleton placeholders instead of rows. */
  loading?: boolean;
  /** Number of skeleton rows to show during loading. */
  skeletonRows?: number;
  /** Right-side actions column — a single `RowActionsMenu` per row. */
  rowActions?: (row: T) => React.ReactNode;
  /** Width of the actions column. Default 56px (one ⋯ trigger). */
  rowActionsWidth?: string;
  /** Click handler for a whole row - turns the row into a button. */
  onRowClick?: (row: T) => void;
  /** Empty state when rows.length === 0 and not loading. */
  empty?: {
    icon?: IconName;
    title: string;
    description?: string;
    action?: React.ReactNode;
  };
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  skeletonRows = 5,
  rowActions,
  rowActionsWidth = "40px",
  onRowClick,
  empty,
}: DataTableProps<T>) {
  if (!loading && rows.length === 0 && empty) return <DataTableEmpty {...empty} />;
  const cellClass = (c: DataTableColumn<T>) => cn(
    "px-2 py-3 first:ps-4 last:pe-4 sm:px-4",
    c.align === "right" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
    c.hideBelow === "sm" && "hidden sm:table-cell",
    c.hideBelow === "md" && "hidden md:table-cell",
    c.hideBelow === "lg" && "hidden lg:table-cell",
    c.hideBelow === "table-sm" && "hidden @min-[32rem]/table:table-cell",
    c.hideBelow === "table-md" && "hidden @min-[44rem]/table:table-cell",
  );
  return (
    <div className={cn("rounded-2xl bg-card px-1 sm:px-2", columns.some(c => c.hideBelow?.startsWith("table-")) && "@container/table")}>
      <table role="table" aria-busy={loading || undefined} className="w-full table-fixed border-collapse">
        <thead>
          <tr role="row" className="border-b border-border/60">
            {columns.map(c => (
              <th role="columnheader" scope="col" key={c.key}
                style={{ width: c.width.endsWith("px") ? c.width : undefined }}
                className={cn(cellClass(c), "text-xs font-medium text-muted-foreground")}>
                {c.header}
              </th>
            ))}
            {rowActions && <th role="columnheader" scope="col" style={{ width: rowActionsWidth }} />}
          </tr>
        </thead>
        <tbody role="rowgroup" className="divide-y divide-border/50">
          {loading ? Array.from({ length: skeletonRows }, (_, index) => (
            <tr key={index} aria-hidden="true">
              {columns.map(c => <td key={c.key} className={cellClass(c)}>{c.skeleton ?? <Skeleton className="h-4 w-3/4" />}</td>)}
              {rowActions && <td />}
            </tr>
          )) : rows.map(row => (
            <tr role="row" key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn("transition-colors hover:bg-muted/25", onRowClick && "cursor-pointer")}>
              {columns.map(c => (
                <td role="cell" key={c.key} className={cn(cellClass(c), "text-sm")}>{c.cell(row)}</td>
              ))}
              {rowActions && (
                <td role="cell" className="pe-2" onClick={event => event.stopPropagation()}>
                  <div className="flex justify-end">{rowActions(row)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataTableEmpty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 py-16 px-6 text-center">
      {Icon && (
        <div className="mx-auto w-16 h-16 rounded-full bg-muted/60 flex items-center justify-center mb-5">
          <UiIcon name={Icon}
            className="size-7 text-muted-foreground/60"
          />
        </div>
      )}
      <h3
        className="text-lg font-medium text-foreground/80 mb-2"
        style={{ letterSpacing: "-0.2px" }}
      >
        {title}
      </h3>
      {description && (
        <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed mb-6">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}

// ─── Row actions - one ⋯ menu per row ───────────────────────────────────────

/**
 * Every row action lives behind this menu, destructive ones included: a bare
 * trash icon parked at the row's edge sits one stray click away from the row's
 * own action, and it advertises deletion as the primary thing a row offers.
 */
export function RowActionsMenu({
  label,
  actions,
  triggerText,
}: {
  label: string;
  actions: MenuAction[];
  triggerText?: string;
}) {
  return (
    <DropdownMenu
      align="right"
      actions={actions}
      triggerLabel={label}
      trigger={
        triggerText && (
          <>
            {triggerText}
            <UiIcon name="chevron-down" className="size-3.5 shrink-0" />
          </>
        )
      }
      triggerClassName={cn(
        "inline-flex h-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
        triggerText
          ? "gap-1.5 bg-secondary px-2.5 text-xs font-medium text-secondary-foreground"
          : "w-8",
      )}
    />
  );
}

export type { MenuAction };
