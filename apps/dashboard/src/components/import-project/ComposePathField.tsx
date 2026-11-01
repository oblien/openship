"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useRef, useState } from "react";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    if (pending || deployment?.isRescanning || !isDirty) return;
    setPending(true);
    setError(null);
    const result = await rescan(trimmed);
    if (!result.success) setError(result.error ?? cp.scanFailed);
    setPending(false);
  };

  return (
    <div
      className="rounded-2xl bg-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 rounded-2xl px-5 py-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center justify-center rounded-xl ${
              composeActive ? "w-9 h-9 bg-info/10" : "w-8 h-8 bg-muted/60"
            }`}
          >
            <UiIcon name="layers"
              className={composeActive ? "size-[18px] text-info" : "size-4 text-muted-foreground"}
            />
          </div>
          <div>
            <p
              className={
                composeActive
                  ? "text-sm font-semibold text-foreground"
                  : "text-sm font-medium text-muted-foreground"
              }
            >
              {cp.title}
            </p>
            <p className="text-xs text-muted-foreground break-all">{subtitle}</p>
          </div>
        </div>
        {open ? (
          <UiIcon name="chevron-up" className="size-4 text-muted-foreground" />
        ) : (
          <UiIcon name="chevron-down" className="size-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-border/50 pt-4">
          <label htmlFor="deploy-compose-path" className="text-sm font-medium text-foreground mb-1.5 block">
            {cp.label}
            <span className="text-xs text-muted-foreground ms-1">
              {t.importProject.buildSettings.optional}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <Input
              dir="ltr"
              id="deploy-compose-path"
              variant="filled"
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
              disabled={pending || deployment?.isRescanning}
              placeholder="deploy/docker-compose/docker-compose.yml"
              aria-invalid={!!error}
              aria-describedby={error ? "deploy-compose-path-error" : "deploy-compose-path-hint"}
              className="flex-1 min-w-0 font-mono"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => void apply()}
              disabled={pending || deployment?.isRescanning || !isDirty}
              className="h-11 shrink-0"
            >
              {pending ? (
                <UiIcon name="spinner" className="size-3.5 animate-spin" />
              ) : (
                <UiIcon name="layers" className="size-3.5" />
              )}
              {pending ? cp.scanning : cp.apply}
            </Button>
          </div>
          <p id="deploy-compose-path-hint" className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
            {cp.description}
          </p>
          {error && <p id="deploy-compose-path-error" role="alert" className="text-xs text-danger mt-1.5 leading-relaxed">{error}</p>}
        </div>
      )}
    </div>
  );
};

export default ComposePathField;
