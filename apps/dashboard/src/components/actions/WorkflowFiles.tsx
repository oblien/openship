"use client";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/button";

export function WorkflowFiles({
  files,
  selected,
  active,
  onSelect,
  onPreview,
}: {
  files: Array<{ path: string; name: string }>;
  selected: string[];
  active: string;
  onSelect: (paths: string[]) => void;
  onPreview: (path: string) => void;
}) {
  const { t } = useI18n();
  const c = t.actions.integration;
  const all = files.every((file) => selected.includes(file.path));
  const clear = all || (files.length > 50 && selected.length > 0);
  return (
    <section className="space-y-2" aria-label={c.workflowFiles}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{c.workflowFiles}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1.5 text-xs"
          disabled={!clear && files.length > 50}
          onClick={() => onSelect(clear ? [] : files.map((file) => file.path))}
        >
          {clear ? c.clearSelection : c.selectAll}
        </Button>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl bg-background p-1.5">
        {files.map((file) => (
          <div
            key={file.path}
            className={`flex items-center gap-2 rounded-lg px-2 ${file.path === active ? "bg-muted" : "hover:bg-muted/50"}`}
          >
            <Checkbox
              size="sm"
              checked={selected.includes(file.path)}
              disabled={!selected.includes(file.path) && selected.length >= 50}
              aria-label={`${c.includeFile}: ${file.name}`}
              onCheckedChange={(checked) =>
                onSelect(
                  checked
                    ? [...selected, file.path]
                    : selected.filter((path) => path !== file.path),
                )
              }
            />
            <button
              type="button"
              aria-pressed={file.path === active}
              className="flex min-w-0 flex-1 items-center gap-2 py-2 text-start focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onPreview(file.path)}
            >
              <Icon name="play-circle" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs" title={file.path}>
                {file.name}
              </span>
              {file.path === active && (
                <Icon
                  name="chevron-right"
                  className="size-3 shrink-0 text-muted-foreground rtl:rotate-180"
                />
              )}
            </button>
          </div>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {interpolate(c.selectedFiles, { count: String(selected.length) })}
        {files.length > 50 && <> {c.fileLimit}</>}
      </p>
    </section>
  );
}
