"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Layers, Loader2 } from "lucide-react";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";

/**
 * "My compose file isn't at the repo root" — point the scan at it.
 *
 * Its own card rather than a BuildSettings row, because unlike every other field
 * it can't be applied locally (projectType, the service list and their env all
 * come from the compose file) and it must outlive the type it was set from:
 * applying a path flips the wizard to the compose view, so a control living
 * inside the app/docker section would vanish the moment it worked.
 */
export const ComposePathField: React.FC = () => {
  const deployment = useOptionalDeployment();
  const { t } = useI18n();
  const cp = t.importProject.buildSettings.composePath;

  const saved = deployment?.config?.composePath ?? "";
  const [value, setValue] = useState(saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open when a path is already in effect, so an existing pin is visible without
  // hunting for it (a re-scan or config-edit can set it after first render).
  const [open, setOpen] = useState(!!saved);

  // Adopt the pin in effect ONLY when it actually changes — a successful scan, or
  // a saved project hydrating. Keyed on a real change rather than on every render
  // or on `pending`, so an in-flight or failed scan never discards what the user
  // typed (which is precisely the text they need to fix a typo).
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setValue(saved);
    if (saved) setOpen(true);
  }, [saved]);

  const rescan = deployment?.rescanWithComposePath;
  if (!rescan) return null;

  const trimmed = value.trim();
  const isDirty = trimmed !== saved.trim();

  // Compose is "active" when the wizard flipped to services (a compose was
  // detected) or the operator pinned a path. Only then is this a prominent,
  // detected card. Otherwise it's an opt-in affordance for a single-app/static
  // repo whose compose lives off-root — demoted + honest copy (#332 UX). It must
  // never CLAIM a detection that didn't happen.
  const composeActive = deployment?.config?.projectType === "services" || !!saved;
  const subtitle = saved || (composeActive ? cp.subtitle : cp.subtitleOptIn);

  const apply = async () => {
    if (pending || !isDirty) return;
    setPending(true);
    setError(null);
    const result = await rescan(trimmed);
    if (!result.success) setError(result.error ?? cp.scanFailed);
    setPending(false);
  };

  return (
    <div
      className={`rounded-2xl border border-border/50 ${
        composeActive ? "bg-card" : "bg-muted/20"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-start"
      >
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center justify-center rounded-xl ${
              composeActive ? "w-9 h-9 bg-info/10" : "w-8 h-8 bg-muted/60"
            }`}
          >
            <Layers
              className={composeActive ? "size-[18px] text-info" : "size-4 text-muted-foreground"}
            />
          </div>
          <div>
            <p
              className={
                composeActive
                  ? "text-[15px] font-semibold text-foreground"
                  : "text-sm font-medium text-muted-foreground"
              }
            >
              {cp.title}
            </p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {open ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-border/50 pt-4">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {cp.label}
            <span className="text-muted-foreground/50 ms-1">
              {t.importProject.buildSettings.optional}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void apply();
                }
              }}
              disabled={pending}
              placeholder="deploy/docker-compose/docker-compose.yml"
              className="flex-1 min-w-0 px-3.5 py-2.5 border border-border/50 rounded-lg text-sm text-foreground bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void apply()}
              disabled={pending || !isDirty}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-xs font-medium border border-border/50 text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Layers className="size-3.5" />
              )}
              {pending ? cp.scanning : cp.apply}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-1.5 leading-relaxed">
            {cp.description}
          </p>
          {error && <p className="text-[11px] text-danger mt-1.5 leading-relaxed">{error}</p>}
        </div>
      )}
    </div>
  );
};

export default ComposePathField;
