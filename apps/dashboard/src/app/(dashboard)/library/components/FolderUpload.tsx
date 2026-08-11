"use client";

import React, { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2, AlertCircle, Package, X, ArrowRight, ArrowLeft } from "lucide-react";
import { buildFolderTarGz, collectFolderFiles } from "@/utils/tarGz";
import { encodeUploadSlug } from "@/utils/repoSlug";
import { folderApi } from "@/lib/api/folder";
import { frameworks, type FrameworkConfig } from "@/components/import-project/Frameworks";
import { useI18n, interpolate } from "@/components/i18n-provider";

type Phase = "idle" | "packing" | "uploading";

interface Picked {
  files: File[];
  name: string;
  packageManager: string;
  fileCount: number;
}

/** Detect the package manager from lockfiles present in the picked tree. */
function detectPackageManager(paths: Set<string>): string {
  if (paths.has("bun.lockb") || paths.has("bun.lock")) return "bun";
  if (paths.has("pnpm-lock.yaml")) return "pnpm";
  if (paths.has("yarn.lock")) return "yarn";
  return "npm";
}

/**
 * Folder-upload entry: the user first picks the stack (reusing the framework
 * grid — no auto-detection), which fixes the build image up front, then uploads
 * the folder. We pack in the browser, open a session, upload straight to the
 * build workspace (SaaS) or the API (self-hosted), and hand off to the deploy
 * wizard seeded from the chosen stack.
 */
export function FolderUpload() {
  const { t } = useI18n();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [stack, setStack] = useState<FrameworkConfig | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    setError("");
    const entries = collectFolderFiles(fileList);
    if (entries.length === 0) {
      setError(t.library.folderUpload.emptyFolder);
      return;
    }

    const relPaths = new Set(entries.map((e) => e.path));
    const files = entries.map((e) => e.file);

    let name = "";
    const pkgEntry = entries.find((e) => e.path === "package.json");
    if (pkgEntry) {
      try {
        const pkg = JSON.parse(await pkgEntry.file.text());
        if (typeof pkg?.name === "string") name = pkg.name;
      } catch {
        /* ignore malformed package.json */
      }
    }
    if (!name) {
      const rel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
      name = rel.split("/")[0] || "app";
    }

    setPicked({ files, name, packageManager: detectPackageManager(relPaths), fileCount: entries.length });
  }, []);

  const handleDeploy = async () => {
    if (!picked || !stack) return;
    setError("");
    try {
      setPhase("packing");
      const { blob } = await buildFolderTarGz(picked.files);

      setPhase("uploading");
      const session = await folderApi.createSession({
        stack: stack.id,
        packageManager: picked.packageManager,
        name: picked.name,
      });
      await folderApi.upload(session, blob);

      const params = new URLSearchParams({ stack: stack.id, name: picked.name });
      router.push(`/deploy/${encodeUploadSlug(session.sessionId)}?${params.toString()}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t.library.folderUpload.uploadError);
      setPhase("idle");
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  };

  // ── Step 1: pick the stack ──────────────────────────────────────────────
  if (!stack) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="mb-4">
          <h2 className="font-semibold text-foreground text-[15px]">{t.library.folderUpload.stackTitle}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t.library.folderUpload.stackDesc}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {frameworks
            .filter((fw) => fw.id !== "static")
            .map((fw) => (
              <button
                key={fw.id}
                onClick={() => setStack(fw)}
                className="flex flex-col items-center gap-3 p-5 rounded-xl border border-border/50 bg-background hover:bg-muted/40 hover:border-border transition-all group"
              >
                <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center group-hover:scale-105 transition-transform">
                  {fw.icon("hsl(var(--foreground))")}
                </div>
                <span className="text-sm font-medium text-foreground">{fw.name}</span>
              </button>
            ))}
        </div>
      </div>
    );
  }

  // ── Step 2: pick the folder ─────────────────────────────────────────────
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-4 border-b border-border/50 flex items-center gap-3">
        {!busy && (
          <button
            onClick={() => { setStack(null); setPicked(null); setError(""); }}
            className="p-1.5 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
            aria-label={t.library.folderUpload.backToStack}
          >
            <ArrowLeft className="size-4 rtl:rotate-180" />
          </button>
        )}
        <div className="w-9 h-9 bg-muted/60 rounded-xl flex items-center justify-center">
          {stack.icon("hsl(var(--foreground))")}
        </div>
        <div>
          <h2 className="font-semibold text-foreground text-[15px]">{interpolate(t.library.folderUpload.uploadTitle, { stack: stack.name })}</h2>
          <p className="text-xs text-muted-foreground">{t.library.folderUpload.uploadSubtitle}</p>
        </div>
      </div>

      <div className="px-5 py-4">
        {!picked ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
              dragging ? "border-primary bg-primary/5" : "border-border/60 hover:border-border hover:bg-muted/30"
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              /* @ts-expect-error webkitdirectory is non-standard */
              webkitdirectory=""
              directory=""
              multiple
              onChange={(e) => e.target.files && void handleFiles(e.target.files)}
            />
            <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-2">
              <Upload className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground mb-0.5">
              {t.library.folderUpload.dropTitle}
            </p>
            <p className="text-xs text-muted-foreground">
              {interpolate(t.library.folderUpload.dropSubtitle, { stack: stack.name })}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-muted/40 border border-border/50">
              <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <Package className="size-[18px] text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{picked.name}</p>
                <p className="text-xs text-muted-foreground">
                  {interpolate(picked.fileCount !== 1 ? t.library.folderUpload.filesPlural : t.library.folderUpload.filesSingular, { count: String(picked.fileCount) })} · {picked.packageManager} · {stack.name}
                </p>
              </div>
              {!busy && (
                <button
                  onClick={() => { setPicked(null); setError(""); }}
                  className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={t.library.folderUpload.clearSelection}
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            <button
              onClick={handleDeploy}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4 rtl:rotate-180" />}
              {phase === "packing" ? t.library.folderUpload.packing : phase === "uploading" ? t.library.folderUpload.uploading : t.library.folderUpload.continue}
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg mt-3 bg-danger-bg border border-danger-border">
            <AlertCircle className="size-4 shrink-0 text-danger" />
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
