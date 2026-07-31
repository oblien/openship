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
  /** Right-side actions column (Edit / Delete buttons). */
  rowActions?: (row: T) => React.ReactNode;
  /** Width of the actions column. Default 96px. */
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
  rowActionsWidth = "96px",
  onRowClick,
  empty,
}: DataTableProps<T>) {
  const gridTemplate = useGridTemplate(columns, rowActions ? rowActionsWidth : null);

  if (!loading && rows.length === 0 && empty) {
    return <DataTableEmpty {...empty} />;
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden" role="table">
      {/* Header row */}
      <div role="rowgroup">
        <div
          className="grid items-center gap-4 px-5 py-3 bg-muted/30 border-b border-border/50"
          style={{ gridTemplateColumns: gridTemplate }}
          role="row"
        >
          {columns.map((c) => (
            <div
              key={c.key}
              className={cn(
                "text-[11px] font-semibold text-muted-foreground uppercase tracking-wide",
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
      </div>

      {/* Body */}
      <div className="divide-y divide-border/40" role="rowgroup">
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
        "grid items-center gap-4 px-5 py-3.5 transition-colors",
        interactive && "cursor-pointer hover:bg-muted/30",
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

// ─── Action button - reused by every row that needs Edit / Delete ────────────

interface RowIconButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
}

export function RowIconButton({
  icon: Icon,
  label,
  onClick,
  variant = "default",
  disabled,
}: RowIconButtonProps) {
  const variantCls =
    variant === "danger"
      ? "hover:text-danger hover:bg-danger-bg"
      : "hover:text-foreground hover:bg-muted/50";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className={cn(
        "p-2 rounded-lg text-muted-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        variantCls,
      )}
      title={label}
      aria-label={label}
      type="button"
    >
      <Icon className="size-4" strokeWidth={2} />
    </button>
  );
}

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
