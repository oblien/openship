"use client";

import React from "react";
import { Code2, ChevronDown, Save } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { Switch } from "@/components/ui/Switch";
import { Input } from "@/components/ui/input";

export interface MountedReleaseConfigUI {
  enabled: boolean;
  serviceName?: string;
  sourcePath?: string;
  containerPath: string;
  sharedPaths?: string[];
  prepareCommand?: string;
  builderImage?: string;
  builderMemoryMb?: number;
  builderCpus?: number;
  reloadCommand?: string;
  healthPath?: string;
  healthPort?: number;
  retain?: number;
}

const emptyConfig: MountedReleaseConfigUI = {
  enabled: true,
  sourcePath: "",
  containerPath: "/srv/openship-app",
  sharedPaths: [],
  healthPath: "/",
  retain: 5,
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {hint ? (
        <span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function MountedReleaseSettings() {
  const { id, projectData, servicesData, updateProjectData } = useProjectSettings();
  const { showToast } = useToast();
  const saved = (projectData.mountedRelease as MountedReleaseConfigUI | null) ?? null;
  const [open, setOpen] = React.useState(Boolean(saved));
  const [draft, setDraft] = React.useState<MountedReleaseConfigUI>(saved ?? emptyConfig);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setDraft(saved ?? emptyConfig);
  }, [projectData.mountedRelease]);

  const set = <K extends keyof MountedReleaseConfigUI>(key: K, value: MountedReleaseConfigUI[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const mountedRelease = {
        ...draft,
        sourcePath: draft.sourcePath?.trim() || undefined,
        sharedPaths: draft.sharedPaths?.filter(Boolean) ?? [],
        prepareCommand: draft.prepareCommand?.trim() || undefined,
        builderImage: draft.builderImage?.trim() || undefined,
        reloadCommand: draft.reloadCommand?.trim() || undefined,
        healthPath: draft.healthPath?.trim() || undefined,
      };
      await projectsApi.update(id, { mountedRelease });
      updateProjectData({ mountedRelease });
      showToast(
        mountedRelease.enabled
          ? "Mounted releases are ready. Rebuild the runtime once to attach the code mount."
          : "Mounted releases paused. The current code remains in place.",
        "success",
        "Release settings saved",
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Could not save release settings.",
        "error",
        "Release settings",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
          <Code2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            Mounted releases
            {saved?.enabled ? (
              <span className="rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                On
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">
            Deploy code in seconds while the runtime image and persistent data stay put.
          </span>
        </span>
        <ChevronDown
          className={`mt-2 size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="border-t border-border/40 px-5 py-5">
          <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
            <div>
              <p className="text-[13px] font-medium text-foreground">Fast code deploys</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Keep this off for projects that must bake code into every image.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onChange={(enabled) => set("enabled", enabled)}
              ariaLabel="Enable mounted releases"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {servicesData.services.length > 0 ? (
              <Field label="App service" hint="Only this container receives the code mount.">
                <select
                  value={draft.serviceName ?? ""}
                  onChange={(event) => set("serviceName", event.target.value || undefined)}
                  className="h-11 w-full rounded-xl border border-input bg-background px-3.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
                >
                  <option value="">Choose a service</option>
                  {servicesData.services.map((service) => (
                    <option key={service.id} value={service.name}>
                      {service.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field
              label="Source directory"
              hint="Repo root by default; for a monorepo use apps/staff, apps/public, etc."
            >
              <Input
                value={draft.sourcePath ?? ""}
                onChange={(event) => set("sourcePath", event.target.value)}
                placeholder="Repo root"
              />
            </Field>
            <Field
              label="Container release root"
              hint="OpenShip mounts one stable parent here; the app runs from /current inside it."
            >
              <Input
                value={draft.containerPath}
                onChange={(event) => set("containerPath", event.target.value)}
                placeholder="/srv/openship-app"
              />
            </Field>
            <Field
              label="Shared paths"
              hint="Comma separated. Use storage for OpenShip-managed data, or storage=/var/www/html/storage to keep an existing container mount."
            >
              <Input
                value={(draft.sharedPaths ?? []).join(", ")}
                onChange={(event) =>
                  set(
                    "sharedPaths",
                    event.target.value
                      .split(",")
                      .map((part) => part.trim())
                      .filter(Boolean),
                  )
                }
                placeholder="storage=/var/www/html/storage, database"
              />
            </Field>
            <Field
              label="Prepare release"
              hint="Optional. Runs in the staged release before it becomes current. Builders can persist dependencies and compiler output under /cache."
            >
              <Input
                value={draft.prepareCommand ?? ""}
                onChange={(event) => set("prepareCommand", event.target.value)}
                placeholder="composer install --no-dev && php artisan optimize"
              />
            </Field>
            <Field
              label="Builder image"
              hint="Optional. Uses a disposable server-side builder instead of adding build tools to the live app."
            >
              <Input
                value={draft.builderImage ?? ""}
                onChange={(event) => set("builderImage", event.target.value)}
                placeholder="node:20-alpine"
              />
            </Field>
            {draft.builderImage ? (
              <Field
                label="Builder limits"
                hint="Memory in MB and CPU cores. The builder is removed automatically."
              >
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    min={128}
                    max={32768}
                    value={draft.builderMemoryMb ?? 1024}
                    onChange={(event) => set("builderMemoryMb", Number(event.target.value))}
                    placeholder="Memory MB"
                  />
                  <Input
                    type="number"
                    min={0.1}
                    max={32}
                    step={0.1}
                    value={draft.builderCpus ?? 1}
                    onChange={(event) => set("builderCpus", Number(event.target.value))}
                    placeholder="CPU cores"
                  />
                </div>
              </Field>
            ) : null}
            <Field
              label="Reload app"
              hint="Optional. Runs in the container after the atomic switch; blank restarts the container."
            >
              <Input
                value={draft.reloadCommand ?? ""}
                onChange={(event) => set("reloadCommand", event.target.value)}
                placeholder="supervisorctl signal USR2 php-fpm"
              />
            </Field>
            <Field
              label="Health path"
              hint="OpenShip rolls back automatically if this does not answer after activation."
            >
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <Input
                  value={draft.healthPath ?? ""}
                  onChange={(event) => set("healthPath", event.target.value)}
                  placeholder="/healthz"
                />
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.healthPort ?? ""}
                  onChange={(event) =>
                    set("healthPort", event.target.value ? Number(event.target.value) : undefined)
                  }
                  placeholder="Port"
                />
              </div>
            </Field>
            <Field
              label="Keep releases"
              hint="Older code trees are removed; pinned deployments are always retained."
            >
              <Input
                type="number"
                min={2}
                max={20}
                value={draft.retain ?? 5}
                onChange={(event) => set("retain", Number(event.target.value))}
              />
            </Field>
          </div>

          <div className="mt-5 flex items-center justify-between gap-4 border-t border-border/40 pt-4">
            <p className="max-w-xl text-[11px] leading-4 text-muted-foreground">
              The first runtime rebuild attaches the stable mount. After that, Deploy code only
              fetches source, prepares a release, flips current, reloads, and checks health.
            </p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                !draft.containerPath.trim() ||
                (servicesData.services.length > 0 && !draft.serviceName)
              }
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="size-4" />
              {saving ? "Saving…" : "Save release mode"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
