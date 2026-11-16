"use client";

import { useState } from "react";
import { EDGE_PAGE_LIMIT, EDGE_PAGE_STATUSES, type EdgePages } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import { HtmlDocumentEditor } from "./HtmlDocumentEditor";

export const emptyEdgePages = (): EdgePages => ({ files: [], errors: [] });
const starter =
  '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>We’ll be back shortly</title>\n  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px/1.6 system-ui}main{max-width:440px;padding:32px}p{color:#aaa}</style>\n</head>\n<body>\n  <main><h1>We’ll be back shortly.</h1><p>Please try again in a little while.</p></main>\n</body>\n</html>';

/** Same document library and bindings for server defaults and project overrides. */
export function EdgePagesEditor({
  value,
  onChange,
  server = false,
  disabled = false,
  inheritedMaintenance,
}: {
  value: EdgePages;
  onChange: (next: EdgePages) => void;
  server?: boolean;
  disabled?: boolean;
  inheritedMaintenance?: EdgePages;
}) {
  const { t } = useI18n();
  const w = t.widgets.routing.pages;
  const [editing, setEditing] = useState<string | null>(null);
  const files = value.files;
  const inheritsMaintenance = !value.maintenance && !!inheritedMaintenance?.maintenance;
  const maintenance = value.maintenance ?? inheritedMaintenance?.maintenance;
  const options = [
    { value: "", label: w.builtIn },
    ...files.map((file) => ({ value: file.id, label: file.name })),
  ];
  const select = (label: string, selected: string | undefined, change: (value: string) => void) => (
    <CustomSelect
      aria-label={label}
      value={selected ?? ""}
      onChange={change}
      options={options}
      disabled={disabled}
      variant="filled"
      triggerClassName="bg-muted/60 hover:bg-muted"
    />
  );
  const patch = (updates: Partial<EdgePages>) => onChange({ ...value, ...updates });
  const inheritedFile = inheritsMaintenance
    ? inheritedMaintenance!.files.find((file) => file.id === maintenance!.pageId)
    : undefined;
  const existingFile = inheritedFile && files.find((file) => file.html === inheritedFile.html);
  const canCopyMaintenance = !inheritedFile || !!existingFile || files.length < EDGE_PAGE_LIMIT;
  const customizeMaintenance = (enabled: boolean) => {
    const copy =
      enabled && inheritedFile && !existingFile
        ? { ...inheritedFile, id: crypto.randomUUID() }
        : undefined;
    patch({
      files: copy ? [...files, copy] : files,
      maintenance: {
        retryAfter: maintenance?.retryAfter ?? 300,
        enabled,
        pageId: inheritsMaintenance ? (copy ?? existingFile)?.id : value.maintenance?.pageId,
      },
    });
  };
  return (
    <div className="space-y-4">
      {!server && (
        <section className="rounded-2xl bg-card p-5 space-y-4">
          <div className="flex items-start justify-between gap-5">
            <div>
              <h3 className="text-base font-medium">{w.maintenance}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{w.maintenanceHint}</p>
            </div>
            <Switch
              checked={maintenance?.enabled ?? false}
              ariaLabel={w.maintenance}
              disabled={disabled || (!maintenance?.enabled && !canCopyMaintenance)}
              onChange={customizeMaintenance}
            />
          </div>
          {inheritsMaintenance && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{w.inheritMaintenance}</p>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled || !canCopyMaintenance}
                onClick={() => customizeMaintenance(maintenance!.enabled)}
              >
                {w.customizeMaintenance}
              </Button>
            </div>
          )}
          {value.maintenance?.enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span>{w.page}</span>
                {select(w.maintenance, value.maintenance.pageId, (pageId) =>
                  patch({ maintenance: { ...value.maintenance!, pageId: pageId || undefined } }),
                )}
              </label>
              <label className="space-y-2 text-sm">
                <span>{w.retryAfter}</span>
                <Input
                  variant="filled"
                  type="number"
                  min={60}
                  max={86400}
                  value={value.maintenance.retryAfter}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({
                      maintenance: {
                        ...value.maintenance!,
                        retryAfter: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            </div>
          )}
        </section>
      )}
      <section className="rounded-2xl bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-base font-medium">{w.files}</h3>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || files.length >= EDGE_PAGE_LIMIT}
            onClick={() => {
              const id = crypto.randomUUID();
              patch({
                files: [...files, { id, name: `page-${files.length + 1}.html`, html: starter }],
              });
              setEditing(id);
            }}
          >
            <Icon name="plus" size={16} />
            {w.addFile}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{w.filesHint}</p>
        {!files.length && <p className="py-3 text-sm text-muted-foreground">{w.noFiles}</p>}
        {files.map((file) => {
          const used =
            value.errors.some((error) => error.pageId === file.id) ||
            value.maintenance?.pageId === file.id ||
            value.defaultPageId === file.id;
          return (
            <div key={file.id} className="rounded-xl bg-card">
              <div className="flex items-center gap-3 p-3">
                <Icon name="code" className="size-5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-start text-sm font-medium"
                  onClick={() => setEditing(editing === file.id ? null : file.id)}
                >
                  {file.name}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(editing === file.id ? null : file.id)}
                >
                  {editing === file.id ? w.done : w.edit}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={w.remove}
                  title={used ? w.inUse : w.remove}
                  disabled={disabled || used}
                  onClick={() => patch({ files: files.filter((item) => item.id !== file.id) })}
                >
                  <Icon name="trash" size={16} />
                </Button>
              </div>
              {editing === file.id && (
                <div className="space-y-4 px-4 pb-4">
                  <label className="block space-y-2 text-sm">
                    <span>{w.filename}</span>
                    <Input
                      variant="filled"
                      value={file.name}
                      disabled={disabled}
                      maxLength={100}
                      onChange={(event) =>
                        patch({
                          files: files.map((item) =>
                            item.id === file.id ? { ...item, name: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <HtmlDocumentEditor
                    value={file.html}
                    disabled={disabled}
                    onChange={(html) =>
                      patch({
                        files: files.map((item) =>
                          item.id === file.id ? { ...item, html } : item,
                        ),
                      })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </section>
      <section className="rounded-2xl bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-base font-medium">{w.errors}</h3>
          <Button
            variant="secondary"
            size="sm"
            disabled={
              disabled || !files.length || value.errors.length === EDGE_PAGE_STATUSES.length
            }
            onClick={() => {
              const status = [502, 503, 504, ...EDGE_PAGE_STATUSES].find(
                (code) => !value.errors.some((error) => error.status === code),
              )!;
              patch({
                errors: [
                  ...value.errors,
                  { status: status as EdgePages["errors"][number]["status"], pageId: files[0].id },
                ],
              });
            }}
          >
            <Icon name="plus" size={16} />
            {w.assign}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{w.errorsHint}</p>
        {!value.errors.length && (
          <p className="text-sm text-muted-foreground">
            {server ? w.defaultErrors : w.inheritedErrors}
          </p>
        )}
        {value.errors.map((error, index) => (
          <div key={index} className="flex items-center gap-3">
            <CustomSelect
              aria-label={w.status}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
              className="w-28 shrink-0"
              value={String(error.status)}
              disabled={disabled}
              options={EDGE_PAGE_STATUSES.filter(
                (code) =>
                  code === error.status || !value.errors.some((item) => item.status === code),
              ).map((code) => ({ value: String(code), label: String(code) }))}
              onChange={(code) =>
                patch({
                  errors: value.errors.map((item, i) =>
                    i === index ? { ...item, status: Number(code) as typeof error.status } : item,
                  ),
                })
              }
            />
            <CustomSelect
              aria-label={w.page}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
              className="min-w-0 flex-1"
              value={error.pageId}
              disabled={disabled}
              options={options.slice(1)}
              onChange={(pageId) =>
                patch({
                  errors: value.errors.map((item, i) => (i === index ? { ...item, pageId } : item)),
                })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={w.remove}
              disabled={disabled}
              onClick={() => patch({ errors: value.errors.filter((_, i) => i !== index) })}
            >
              <Icon name="trash" size={16} />
            </Button>
          </div>
        ))}
      </section>
      {server && (
        <section className="rounded-2xl bg-card p-5 space-y-4">
          <div>
            <h3 className="text-base font-medium">{w.defaultAddress}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{w.defaultAddressHint}</p>
          </div>
          {select(w.defaultAddress, value.defaultPageId, (defaultPageId) =>
            patch({ defaultPageId: defaultPageId || undefined }),
          )}
        </section>
      )}
    </div>
  );
}
