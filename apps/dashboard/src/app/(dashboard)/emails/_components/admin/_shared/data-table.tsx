"use client";

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
import type { LucideIcon } from "lucide-react";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { Skeleton } from "./skeleton";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** CSS grid-template column value: `1fr`, `200px`, `minmax(160px, 1fr)`, etc. */
  width: string;
  align?: "left" | "right" | "center";
  /** Hide on small screens. Useful for secondary columns. */
  hideBelow?: "sm" | "md" | "lg";
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
    icon?: LucideIcon;
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
  rowActionsWidth = "56px",
  onRowClick,
  empty,
}: DataTableProps<T>) {
  const gridTemplate = useGridTemplate(columns, rowActions ? rowActionsWidth : null);

  if (!loading && rows.length === 0 && empty) {
    return <DataTableEmpty {...empty} />;
  }

  return (
    // No overflow-hidden: a row's ⋯ menu renders in-flow, so it would be
    // clipped on the last row. Corners come from the header + last row instead.
    <div className="bg-card rounded-2xl border border-border/50">
      {/* Header row. A hairline and quieter labels, no grey fill strip: the
          dashboard's other lists head their cards this way, and the filled bar
          read as a second surface stacked on the card. */}
      <div
        className="grid items-center gap-4 px-5 pt-4 pb-2.5 border-b border-border/50 rounded-t-2xl"
        style={{ gridTemplateColumns: gridTemplate }}
        role="row"
      >
        {columns.map((c) => (
          <div
            key={c.key}
            className={cn(
              "text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider",
              alignClass(c.align),
              hideBelowClass(c.hideBelow),
            )}
            role="columnheader"
          >
            {c.header}
          </div>
        ))}
        {rowActions && <div />}
      </div>

      {/* Body */}
      <div className="divide-y divide-border/50">
        {loading
          ? Array.from({ length: skeletonRows }).map((_, i) => (
              <DataTableRowSkeleton
                key={i}
                gridTemplate={gridTemplate}
                columnCount={columns.length}
                hasActions={!!rowActions}
              />
            ))
          : rows.map((row) => (
              <DataTableRow
                key={rowKey(row)}
                row={row}
                columns={columns}
                gridTemplate={gridTemplate}
                rowActions={rowActions}
                onRowClick={onRowClick}
              />
            ))}
      </div>
    </div>
  );
}

function DataTableRow<T>({
  row,
  columns,
  gridTemplate,
  rowActions,
  onRowClick,
}: {
  row: T;
  columns: DataTableColumn<T>[];
  gridTemplate: string;
  rowActions?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
}) {
  const interactive = !!onRowClick;
  return (
    <div
      role="row"
      onClick={interactive ? () => onRowClick(row) : undefined}
      className={cn(
        "grid items-center gap-4 px-5 py-4 transition-colors last:rounded-b-2xl",
        interactive && "cursor-pointer hover:bg-foreground/[0.03]",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {columns.map((c) => (
        <div
          key={c.key}
          role="cell"
          className={cn(
            "min-w-0 text-sm text-foreground",
            alignClass(c.align),
            hideBelowClass(c.hideBelow),
          )}
        >
          {c.cell(row)}
        </div>
      ))}
      {rowActions && (
        <div
          className="flex items-center justify-end gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {rowActions(row)}
        </div>
      )}
    </div>
  );
}

function DataTableRowSkeleton({
  gridTemplate,
  columnCount,
  hasActions,
}: {
  gridTemplate: string;
  columnCount: number;
  hasActions: boolean;
}) {
  return (
    <div
      className="grid items-center gap-4 px-5 py-4"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {Array.from({ length: columnCount }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn(
            "h-3.5",
            i === 0 ? "w-40" : "w-20",
            i === 0 ? "" : "justify-self-start",
          )}
        />
      ))}
      {hasActions && <Skeleton className="h-6 w-16 justify-self-end" />}
    </div>
  );
}

function DataTableEmpty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 py-16 px-6 text-center">
      {Icon && (
        <div className="mx-auto w-16 h-16 rounded-full bg-muted/60 flex items-center justify-center mb-5">
          <Icon
            className="size-7 text-muted-foreground/60"
            strokeWidth={1.5}
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
export function RowActionsMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  return (
    <DropdownMenu
      align="right"
      actions={actions}
      triggerLabel={label}
      triggerClassName="flex size-8 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
    />
  );
}

export type { MenuAction };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useGridTemplate<T>(
  columns: DataTableColumn<T>[],
  rowActionsWidth: string | null,
): string {
  const parts = columns.map((c) => c.width);
  if (rowActionsWidth) parts.push(rowActionsWidth);
  return parts.join(" ");
}

function alignClass(align: DataTableColumn<unknown>["align"]): string {
  if (align === "right") return "text-end justify-self-end";
  if (align === "center") return "text-center justify-self-center";
  return "text-start";
}

function hideBelowClass(hide: DataTableColumn<unknown>["hideBelow"]): string {
  if (hide === "sm") return "hidden sm:block";
  if (hide === "md") return "hidden md:block";
  if (hide === "lg") return "hidden lg:block";
  return "";
}
