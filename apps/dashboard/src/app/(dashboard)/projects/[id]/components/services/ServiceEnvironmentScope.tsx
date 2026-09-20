import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { DismissiblePopover } from "@/components/ui/Popover";
import { projectsApi } from "@/lib/api/projects";

/** Names only: explaining precedence never needs to reveal a secret value. */
export function ServiceEnvironmentScope({
  projectId,
  keys,
}: {
  projectId: string;
  keys: readonly string[];
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.serviceEnvironment;
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [shared, setShared] = useState<{
    projectId: string;
    keys: string[];
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    projectsApi
      .getEnv(projectId)
      .then((result) => {
        if (!cancelled)
          setShared({
            projectId,
            keys: result.data
              .filter((row) => row.environment === "production")
              .map((row) => row.key),
          });
      })
      .catch(() => {
        if (!cancelled) setShared({ projectId, keys: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, open]);
  const current = shared?.projectId === projectId ? shared : null;
  const sharedKeys = new Set(current?.keys);
  const overrides = [...new Set(keys.map((key) => key.trim()))]
    .filter((key) => sharedKeys.has(key))
    .sort();

  return (
    <DismissiblePopover open={open} onOpenChange={setOpen} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={copy.title}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") trigger.current?.focus();
        }}
        className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Info className="size-4" />
      </button>
      {open && (
        <div
          id={contentId}
          role="region"
          aria-label={copy.title}
          onKeyDown={(event) => {
            if (event.key === "Escape") trigger.current?.focus();
          }}
          className="absolute start-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-4rem)] space-y-3 rounded-xl border border-border/60 bg-popover p-4 text-[13px] leading-relaxed text-muted-foreground shadow-lg"
        >
          <p>{copy.description}</p>
          {overrides.length > 0 && (
            <p className="break-words text-foreground">
              {interpolate(copy.overrides, { keys: overrides.join(", ") })}
            </p>
          )}
          {current?.failed && <p>{copy.loadFailed}</p>}
          <p>{copy.buildArguments}</p>
          <Link href={`/projects/${projectId}/runtime`} className="inline-block font-medium text-primary hover:underline">
            {copy.projectLink}
          </Link>
        </div>
      )}
    </DismissiblePopover>
  );
}
