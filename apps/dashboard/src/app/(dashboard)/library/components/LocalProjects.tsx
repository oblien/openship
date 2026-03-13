"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  FolderOpen,
  Plus,
  Trash2,
  ArrowRight,
  Loader2,
  Package,
  AlertCircle,
  CheckCircle2,
  X,
  Upload,
  FolderInput,
  Zap,
  HardDrive,
} from "lucide-react";
import { projectsApi } from "@/lib/api/projects";

/* ── Types ────────────────────────────────────────────────────────── */

interface LocalProject {
  id: string;
  name: string;
  slug: string;
  localPath: string | null;
  framework: string | null;
  packageManager: string | null;
  port: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ScanResult {
  success: boolean;
  name: string;
  path: string;
  stack: string;
  category: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
}

/* ── Component ────────────────────────────────────────────────────── */

export function LocalProjects() {
  const router = useRouter();
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await projectsApi.getLocal();
      setProjects(res.projects ?? []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleDelete = async (id: string) => {
    try {
      await projectsApi.deleteLocal(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch {
      // Silently fail
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      {/* ── Header ─────────────────────────────── */}
      {(projects.length > 0 || showImport) && (
        <div className="px-5 py-4 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-primary/10 rounded-xl flex items-center justify-center">
              <FolderOpen className="size-[18px] text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-[15px]">Local Projects</h2>
              <p className="text-xs text-muted-foreground">
                {loading ? "Loading..." : `${projects.length} project${projects.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="size-3.5" />
            Import
          </button>
        </div>
      )}

      {/* ── Import form ──────────────────────────── */}
      {showImport && (
        <ImportForm
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            fetchProjects();
          }}
        />
      )}

      {/* ── Project list ─────────────────────────── */}
      {loading ? (
        <div className="divide-y divide-border/50">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
              <div className="w-10 h-10 bg-muted rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-3 w-48 bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : projects.length === 0 && !showImport ? (
        <EmptyState onImport={() => setShowImport(true)} />
      ) : (
        <div className="divide-y divide-border/50">
          {projects.map((project) => (
            <div
              key={project.id}
              className="px-5 py-3.5 flex items-center gap-4 hover:bg-muted/40 transition-colors group"
            >
              <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-muted transition-colors">
                <Package className="size-[18px] text-muted-foreground" />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{project.name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-muted-foreground truncate font-mono">{project.localPath}</p>
                  {project.framework && project.framework !== "unknown" && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="text-xs text-muted-foreground capitalize">{project.framework}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(project.id);
                  }}
                  className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-red-500 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
                <button
                  onClick={() => router.push(`/project/${project.id}`)}
                  className="p-1.5 rounded-lg text-muted-foreground/40 group-hover:text-muted-foreground transition-colors"
                >
                  <ArrowRight className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Empty State ──────────────────────────────────────────────────── */

function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="py-16 text-center">
      {/* SVG Illustration — folder + import theme */}
      <div className="relative mx-auto w-64 h-44 mb-8">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
          {/* Background card stack */}
          <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
          <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

          {/* Card header */}
          <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
          <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
          <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
          <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />

          {/* Folder icon (center of card) */}
          <rect x="95" y="65" width="50" height="38" rx="6" fill="var(--th-on-05)" stroke="var(--th-on-12)" strokeWidth="1" />
          <path d="M99 72h16l4 4h22v23H99V72z" fill="var(--th-on-10)" rx="3" />
          {/* Folder tab */}
          <rect x="99" y="68" width="16" height="6" rx="3" fill="var(--th-on-12)" />

          {/* Arrow into folder */}
          <path d="M120 58v12" stroke="var(--th-on-20)" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
          <path d="M116 66l4 5 4-5" stroke="var(--th-on-20)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

          {/* Plus button */}
          <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
          <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />

          {/* Decorative elements */}
          <circle cx="30" cy="60" r="4" fill="var(--th-on-10)" />
          <circle cx="40" cy="140" r="6" fill="var(--th-on-08)" />
          <circle cx="230" cy="40" r="3" fill="var(--th-on-12)" />
          <circle cx="245" cy="130" r="5" fill="var(--th-on-06)" />

          {/* Sparkle accents */}
          <path d="M25 100l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M220 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />

          {/* Connecting line */}
          <path d="M185 95 Q 192 92 195 90" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
        </svg>
      </div>

      <h3 className="text-2xl font-medium text-foreground/80 mb-2" style={{ letterSpacing: "-0.2px" }}>
        No local projects yet
      </h3>
      <p className="text-sm text-muted-foreground/70 max-w-sm mx-auto mb-8 leading-relaxed">
        Import a project folder from your machine to scan, build, and deploy it locally
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
        <button
          onClick={onImport}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
        >
          <Plus className="size-4" />
          Import Project
        </button>
      </div>

      {/* Feature highlights */}
      <div className="max-w-xl mx-auto">
        <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
          How it works
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <FolderInput className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Drop or browse</p>
            <p className="text-xs text-muted-foreground mt-0.5">Select any project folder</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Zap className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Auto-detect</p>
            <p className="text-xs text-muted-foreground mt-0.5">Framework & config found</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left sm:col-span-1 col-span-2">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <HardDrive className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Deploy locally</p>
            <p className="text-xs text-muted-foreground mt-0.5">Build & run on your machine</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Import Form ──────────────────────────────────────────────────── */

interface ImportFormProps {
  onClose: () => void;
  onImported: () => void;
}

function ImportForm({ onClose, onImported }: ImportFormProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState("");
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);

  const handleScan = async (dirPath?: string) => {
    const target = dirPath ?? path.trim();
    if (!target) return;
    setPath(target);
    setScanning(true);
    setScanError("");
    setScanResult(null);

    try {
      const result = await projectsApi.scan(target);
      setScanResult(result);
      setName(result.name);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to scan directory";
      setScanError(message);
    } finally {
      setScanning(false);
    }
  };

  const extractPath = (files: FileList) => {
    // webkitRelativePath gives "folderName/file.ext", extract the root folder
    const first = files[0];
    if (!first) return;

    const rel = (first as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (rel) {
      // webkitRelativePath = "myproject/src/index.ts" → root = "myproject"
      const rootFolder = rel.split("/")[0];
      if (rootFolder) {
        // We only get the folder name, not the full path.
        // Set it as the path and let user confirm/edit before scanning.
        setPath(rootFolder);
        setScanError("Folder selected via browser — please enter the full absolute path and press Scan");
        return;
      }
    }

    // Fallback: just set the file name
    setPath(first.name);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);

    // Try to get the folder path from dataTransfer items
    const items = e.dataTransfer.items;
    if (items?.[0]) {
      const entry = (items[0] as DataTransferItem & { getAsEntry?: () => FileSystemEntry | null; webkitGetAsEntry?: () => FileSystemEntry | null })
        .getAsEntry?.() ?? (items[0] as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
      if (entry) {
        // In standard web context we only get the name, not full path
        setPath(entry.name);
        setScanError("Folder dropped — please enter the full absolute path and press Scan");
        return;
      }
    }

    if (e.dataTransfer.files.length > 0) {
      extractPath(e.dataTransfer.files);
    }
  };

  const handleImport = async () => {
    if (!scanResult || !name.trim()) return;
    setImporting(true);

    try {
      await projectsApi.importLocal({
        name: name.trim(),
        localPath: scanResult.path,
        framework: scanResult.stack,
        packageManager: scanResult.packageManager,
        buildCommand: scanResult.buildCommand,
        installCommand: scanResult.installCommand,
        outputDirectory: scanResult.outputDirectory,
      });
      onImported();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to import project";
      setScanError(message);
      setImporting(false);
    }
  };

  return (
    <div className="px-5 py-4 border-b border-border/50">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">Import from folder</h3>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
          <X className="size-4 text-muted-foreground" />
        </button>
      </div>

      {/* Drop zone + folder picker */}
      {!scanResult && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all mb-3 ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-muted/30"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            /* @ts-expect-error webkitdirectory is non-standard */
            webkitdirectory=""
            multiple
            onChange={(e) => e.target.files && extractPath(e.target.files)}
          />
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-2">
            <Upload className="size-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-0.5">
            Drop a folder here or click to browse
          </p>
          <p className="text-xs text-muted-foreground">
            Select your project folder to auto-detect the framework
          </p>
        </div>
      )}

      {/* Path input + scan */}
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={path}
          onChange={(e) => { setPath(e.target.value); setScanError(""); }}
          onKeyDown={(e) => e.key === "Enter" && handleScan()}
          placeholder="/path/to/your/project"
          className="flex-1 px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono"
        />
        <button
          onClick={() => handleScan()}
          disabled={!path.trim() || scanning}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 text-foreground transition-colors disabled:opacity-50"
        >
          {scanning ? <Loader2 className="size-4 animate-spin" /> : "Scan"}
        </button>
      </div>

      {/* Error */}
      {scanError && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-3 ${
          scanError.includes("please enter")
            ? "bg-amber-500/10 border border-amber-500/20"
            : "bg-red-500/10 border border-red-500/20"
        }`}>
          <AlertCircle className={`size-4 shrink-0 ${
            scanError.includes("please enter") ? "text-amber-500" : "text-red-500"
          }`} />
          <p className={`text-xs ${
            scanError.includes("please enter") ? "text-amber-600 dark:text-amber-400" : "text-red-500"
          }`}>{scanError}</p>
        </div>
      )}

      {/* Scan result */}
      {scanResult && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
            <CheckCircle2 className="size-4 text-green-500 shrink-0" />
            <p className="text-xs text-green-600 dark:text-green-400">
              Detected <span className="font-medium capitalize">{scanResult.stack}</span>
              {scanResult.stack !== "unknown" && (
                <> · {scanResult.packageManager} · {scanResult.category}</>
              )}
            </p>
          </div>

          {/* Editable name */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Project name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Detected config summary */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {scanResult.buildCommand && (
              <div className="px-2.5 py-1.5 rounded-md bg-muted/50">
                <span className="text-muted-foreground">Build:</span>{" "}
                <span className="text-foreground font-mono">{scanResult.buildCommand}</span>
              </div>
            )}
            {scanResult.installCommand && (
              <div className="px-2.5 py-1.5 rounded-md bg-muted/50">
                <span className="text-muted-foreground">Install:</span>{" "}
                <span className="text-foreground font-mono">{scanResult.installCommand}</span>
              </div>
            )}
            {scanResult.outputDirectory && (
              <div className="px-2.5 py-1.5 rounded-md bg-muted/50">
                <span className="text-muted-foreground">Output:</span>{" "}
                <span className="text-foreground font-mono">{scanResult.outputDirectory}</span>
              </div>
            )}
            {scanResult.startCommand && (
              <div className="px-2.5 py-1.5 rounded-md bg-muted/50">
                <span className="text-muted-foreground">Start:</span>{" "}
                <span className="text-foreground font-mono">{scanResult.startCommand}</span>
              </div>
            )}
          </div>

          {/* Import button */}
          <button
            onClick={handleImport}
            disabled={!name.trim() || importing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {importing ? "Importing..." : "Import Project"}
          </button>
        </div>
      )}
    </div>
  );
}
