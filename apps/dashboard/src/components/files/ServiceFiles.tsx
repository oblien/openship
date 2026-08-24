"use client";

/**
 * Read-only file browser for a single deployed service.
 *
 *   directory list  ↔  GET /api/services/files/:serviceId/list
 *   text preview    ↔  GET /api/services/files/:serviceId/read
 *   download        ↔  GET /api/services/files/:serviceId/download
 *
 * Sibling of <ServiceTerminal> and gated identically server-side — this is the
 * same reach as a shell, presented as a browser.
 *
 * Two rules this component holds to:
 *
 *  1. NEVER BUILD A PATH. Navigation always uses the `path` the server returned
 *     for an entry (or a prefix of the current path for breadcrumbs), so
 *     normalization stays in one place and an entry literally named `..` can't
 *     become a client-side traversal.
 *
 *  2. NEVER SILENTLY TRUNCATE. A file over the cap renders as an explicit
 *     refusal with a download offer. A truncated `.env` that looks complete is
 *     worse than no `.env` at all.
 *
 * Layout is single-column on phones: picking a file swaps the list for the
 * viewer (with a back affordance) rather than squeezing two panes side by side.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  FileWarning,
  Folder,
  Link2,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  listServiceFiles,
  readServiceFile,
  downloadServiceFile,
  type ServiceFileEntry,
  type ServiceFileContent,
} from "@/lib/api/service-files";
import { getApiErrorMessage } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface ServiceFilesProps {
  serviceId: string;
  /** Where to open. The service's working directory when known, else the root. */
  initialPath?: string;
}

export function ServiceFiles({ serviceId, initialPath = "/" }: ServiceFilesProps) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.detail.files;

  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<ServiceFileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);

  const [selected, setSelected] = useState<ServiceFileEntry | null>(null);
  const [content, setContent] = useState<ServiceFileContent | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const loadDirectory = useCallback(
    async (target: string) => {
      setListing(true);
      setListError(null);
      try {
        const res = await listServiceFiles(serviceId, target);
        setEntries(res.entries);
        setTruncated(res.truncated);
        // Adopt the server's canonical spelling so breadcrumbs match what was
        // actually listed rather than what was asked for.
        setPath(res.path);
      } catch (err) {
        setEntries(null);
        setListError(getApiErrorMessage(err, copy.loadFailed));
      } finally {
        setListing(false);
      }
    },
    [serviceId, copy.loadFailed],
  );

  useEffect(() => {
    void loadDirectory(initialPath);
  }, [loadDirectory, initialPath]);

  const openEntry = useCallback(
    async (entry: ServiceFileEntry) => {
      if (entry.type === "dir") {
        setSelected(null);
        setContent(null);
        setReadError(null);
        void loadDirectory(entry.path);
        return;
      }

      setSelected(entry);
      setContent(null);
      setReadError(null);
      setDownloadError(null);
      setReading(true);
      try {
        setContent(await readServiceFile(serviceId, entry.path));
      } catch (err) {
        setReadError(getApiErrorMessage(err, copy.readFailed));
      } finally {
        setReading(false);
      }
    },
    [serviceId, loadDirectory, copy.readFailed],
  );

  // Breadcrumb segments, each carrying the absolute prefix it stands for.
  const crumbs = path.split("/").filter(Boolean);
  const crumbPath = (index: number) => `/${crumbs.slice(0, index + 1).join("/")}`;

  return (
    <div className="space-y-4">
      {/* ── Breadcrumb ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          onClick={() => void loadDirectory("/")}
          className="rounded-lg px-2 py-1 font-mono text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          /
        </button>
        {crumbs.map((segment, i) => (
          <span key={crumbPath(i)} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => void loadDirectory(crumbPath(i))}
              className="max-w-[12rem] truncate rounded-lg px-2 py-1 font-mono text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {segment}
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => void loadDirectory(path)}
          disabled={listing}
          title={copy.refresh}
          aria-label={copy.refresh}
          className="ml-auto rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {listing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {/* ── Directory list ───────────────────────────────────── */}
        {/* Hidden on phones once a file is open — see the layout note above. */}
        <div
          className={`${selected ? "hidden md:block" : "block"} bg-card overflow-hidden rounded-2xl border border-border/50`}
        >
          {listError ? (
            <p className="p-4 text-sm text-destructive">{listError}</p>
          ) : entries === null ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {copy.loading}
            </p>
          ) : entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{copy.empty}</p>
          ) : (
            <ul className="max-h-[28rem] divide-y divide-border/40 overflow-y-auto">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => void openEntry(entry)}
                    className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted ${
                      selected?.path === entry.path ? "bg-muted" : ""
                    }`}
                  >
                    {/* The icon shows what it IS (a link); the click follows
                        what it RESOLVES TO, so a symlinked directory opens. */}
                    {entry.symlink ? (
                      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : entry.type === "dir" ? (
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                    {entry.type === "file" && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(entry.size)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {truncated && (
            /* A capped listing that looked complete would tell the operator a
               directory holds 500 files when it holds 40,000. */
            <p className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">
              {interpolate(copy.truncated, { limit: String(entries?.length ?? 0) })}
            </p>
          )}
        </div>

        {/* ── Viewer ───────────────────────────────────────────── */}
        <div
          className={`${selected ? "block" : "hidden md:block"} bg-card overflow-hidden rounded-2xl border border-border/50`}
        >
          {!selected ? (
            <p className="p-4 text-sm text-muted-foreground">{copy.selectPrompt}</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label={copy.back}
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{selected.name}</span>
                <button
                  type="button"
                  disabled={downloading}
                  onClick={async () => {
                    setDownloadError(null);
                    setDownloading(true);
                    try {
                      await downloadServiceFile(serviceId, selected.path, selected.name);
                    } catch (err) {
                      setDownloadError(err instanceof Error ? err.message : copy.downloadFailed);
                    } finally {
                      setDownloading(false);
                    }
                  }}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {downloading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {copy.download}
                </button>
              </div>

              {downloadError && (
                <p className="flex items-start gap-2 border-b border-border/50 px-4 py-2 text-sm text-destructive">
                  <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
                  {downloadError}
                </p>
              )}

              {reading ? (
                <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {copy.loading}
                </p>
              ) : readError ? (
                // Covers the capped case too: the server sends a real status and
                // a plain-language message rather than a partial body.
                <p className="flex items-start gap-2 p-4 text-sm text-destructive">
                  <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
                  {readError}
                </p>
              ) : content?.binary ? (
                <p className="flex items-start gap-2 p-4 text-sm text-muted-foreground">
                  <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
                  {interpolate(copy.binary, { size: formatBytes(content.size) })}
                </p>
              ) : content ? (
                <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre">
                  {content.content}
                </pre>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
