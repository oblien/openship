"use client";

import React from "react";
import { ChevronDown, Code2, PackageCheck, Save, ServerCog, Upload } from "lucide-react";
import {
  isReleasePresetId,
  presetForStack,
  RELEASE_PRESETS,
  RELEASE_PRESET_IDS,
  type ReleaseBuildMode,
  type ReleasePresetId,
  type RuntimeInstall,
} from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { Switch } from "@/components/ui/Switch";
import { Input } from "@/components/ui/input";
import { Choice } from "@/components/ui/Choice";
import { ReleaseRecipeSummary } from "./ReleaseRecipeSummary";
import {
  applyPresetToDraft,
  BUILD_MODE_OPTIONS,
  emptyReleaseConfig,
  inferRuntimeInstall,
  payloadFromDraft,
  PERSIST_OPTIONS,
  RUNTIME_INSTALL_OPTIONS,
  WIZARD_STEPS,
  type MountedReleaseConfigUI,
} from "./release-recipe";

export type { MountedReleaseConfigUI };

function bindDraftService(
  draft: Pick<MountedReleaseConfigUI, "serviceId" | "serviceName">,
  services: Array<{ id: string; name: string }>,
): Pick<MountedReleaseConfigUI, "serviceId" | "serviceName"> {
  if (draft.serviceId) {
    const match = services.find((service) => service.id === draft.serviceId);
    return match
      ? { serviceId: match.id, serviceName: match.name }
      : { serviceId: draft.serviceId, serviceName: draft.serviceName };
  }
  if (!draft.serviceName) return { serviceId: draft.serviceId, serviceName: draft.serviceName };
  const match = services.find((service) => service.name === draft.serviceName);
  return match
    ? { serviceId: match.id, serviceName: match.name }
    : { serviceName: draft.serviceName };
}

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

function OptionCard<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; title: string; copy: string; icon?: React.ComponentType<{ className?: string }> }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = value === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`flex min-h-20 items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40 ${
              selected
                ? "border-primary/60 bg-primary/10"
                : "border-border/50 bg-background hover:border-border"
            }`}
          >
            {Icon ? (
              <span
                className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
                  selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                }`}
              >
                <Icon className="size-4" />
              </span>
            ) : null}
            <span>
              <span className="block text-[13px] font-semibold text-foreground">{option.title}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                {option.copy}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const BUILD_MODE_ICONS: Record<ReleaseBuildMode, React.ComponentType<{ className?: string }>> = {
  prebuilt: PackageCheck,
  upload: Upload,
  server: ServerCog,
};

/** Wizard container — same export so BuildSettings and other callers stay put. */
export function MountedReleaseSettings() {
  const { id, projectData, servicesData, environments, updateProjectData, buildData } =
    useProjectSettings();
  const { showToast } = useToast();
  const saved = (projectData.mountedRelease as MountedReleaseConfigUI | null) ?? null;
  const [open, setOpen] = React.useState(Boolean(saved));
  const [step, setStep] = React.useState(0);
  const [advanced, setAdvanced] = React.useState(false);
  const [draft, setDraft] = React.useState<MountedReleaseConfigUI>(() => {
    const inferred = inferRuntimeInstall({
      framework: projectData.framework,
      composePath: buildData.composePath,
      serviceCount: servicesData.services.length,
    });
    return saved ?? { ...emptyReleaseConfig, runtimeInstall: inferred };
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (saved) {
      setDraft(saved);
      return;
    }
    setDraft((current) => ({
      ...emptyReleaseConfig,
      runtimeInstall: inferRuntimeInstall({
        framework: projectData.framework,
        composePath: buildData.composePath,
        serviceCount: servicesData.services.length,
      }),
      serviceId: current.serviceId,
      serviceName: current.serviceName,
    }));
  }, [projectData.mountedRelease]);

  React.useEffect(() => {
    if (servicesData.services.length === 0) return;
    setDraft((current) => {
      const next = bindDraftService(current, servicesData.services);
      return next.serviceId === current.serviceId && next.serviceName === current.serviceName
        ? current
        : { ...current, serviceId: next.serviceId, serviceName: next.serviceName };
    });
  }, [servicesData.services]);

  const selectedServiceId = servicesData.services.some((service) => service.id === draft.serviceId)
    ? (draft.serviceId ?? "")
    : "";
  const currentEnvironment =
    environments.find((env) => env.id === id) ??
    environments.find((env) => env.slug === projectData.environmentSlug) ??
    null;
  const suggestedPreset = presetForStack(projectData.framework);

  const set = <K extends keyof MountedReleaseConfigUI>(key: K, value: MountedReleaseConfigUI[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const applyPreset = (presetId: ReleasePresetId) => {
    setDraft((current) => applyPresetToDraft(current, presetId));
    if (presetId === "compose" && servicesData.services.length > 0 && !selectedServiceId) {
      setStep(0);
    }
  };

  const togglePersist = (path: string) => {
    setDraft((current) => {
      const next = new Set(current.sharedPaths ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...current, sharedPaths: [...next] };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const mountedRelease = payloadFromDraft(draft);
      await projectsApi.update(id, { mountedRelease });
      updateProjectData({ mountedRelease });
      showToast(
        mountedRelease.enabled
          ? "Release recipe saved. Rebuild the runtime once to attach the code mount."
          : "Mounted releases paused. The current code remains in place.",
        "success",
        "Release recipe saved",
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

  const canAdvance =
    step !== 0 || servicesData.services.length === 0 || Boolean(selectedServiceId) || !draft.enabled;

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
            Release recipe
            {saved?.enabled ? (
              <span className="rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                On
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">
            What runs, how the runtime is installed, how code ships, what persists, how it activates.
          </span>
        </span>
        <ChevronDown
          className={`mt-2 size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="space-y-5 border-t border-border/40 px-5 py-5">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
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

          <div>
            <p className="mb-2 text-[12px] font-medium text-foreground">Apply preset</p>
            <div className="flex flex-wrap gap-2">
              {RELEASE_PRESET_IDS.map((presetId) => {
                const preset = RELEASE_PRESETS[presetId];
                const selected = draft.preset === presetId;
                const suggested = suggestedPreset === presetId;
                return (
                  <button
                    key={presetId}
                    type="button"
                    onClick={() => applyPreset(presetId)}
                    className={`rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      selected
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border/50 bg-background text-muted-foreground hover:border-border hover:text-foreground"
                    }`}
                  >
                    {preset.label}
                    {suggested && !selected ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide">suggested</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <ol className="flex flex-wrap gap-1.5" aria-label="Recipe steps">
            {WIZARD_STEPS.map((item, index) => {
              const active = index === step;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setStep(index)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {index + 1}. {item.title}
                  </button>
                </li>
              );
            })}
          </ol>

          <div>
            <p className="text-[13px] font-semibold text-foreground">{WIZARD_STEPS[step].title}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{WIZARD_STEPS[step].blurb}</p>
          </div>

          {step === 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Environment"
                hint="This recipe is saved on the current environment only."
              >
                <select
                  value={currentEnvironment?.id ?? id}
                  disabled
                  className="h-11 w-full rounded-xl border border-input bg-background px-3.5 text-sm text-foreground"
                >
                  {(environments.length ? environments : [
                    {
                      id,
                      name: projectData.environmentName || "Production",
                      slug: projectData.environmentSlug || "production",
                    },
                  ]).map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))}
                </select>
              </Field>
              {servicesData.services.length > 0 ? (
                <Field label="App service" hint="Picked by stable service id. Only this container receives the code mount.">
                  <select
                    value={selectedServiceId}
                    onChange={(event) => {
                      const serviceId = event.target.value || undefined;
                      const service = servicesData.services.find((row) => row.id === serviceId);
                      setDraft((current) => ({
                        ...current,
                        serviceId,
                        serviceName: service?.name,
                      }));
                    }}
                    className="h-11 w-full rounded-xl border border-input bg-background px-3.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
                  >
                    <option value="">Choose a service</option>
                    {servicesData.services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <p className="self-end text-[12px] text-muted-foreground">
                  Single-app project — the primary container receives the mount.
                </p>
              )}
            </div>
          ) : null}

          {step === 1 ? (
            <OptionCard<RuntimeInstall>
              ariaLabel="How is the runtime installed?"
              options={RUNTIME_INSTALL_OPTIONS}
              value={draft.runtimeInstall ?? "image"}
              onChange={(runtimeInstall) => set("runtimeInstall", runtimeInstall)}
            />
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <OptionCard<ReleaseBuildMode>
                ariaLabel="How should normal code ship?"
                options={BUILD_MODE_OPTIONS.map((option) => ({
                  ...option,
                  icon: BUILD_MODE_ICONS[option.value],
                }))}
                value={draft.buildMode ?? "prebuilt"}
                onChange={(buildMode) => set("buildMode", buildMode)}
              />
              {draft.buildMode === "server" ? (
                <Field
                  label="Prepare release"
                  hint="Runs in the staged release before it becomes current."
                >
                  <Input
                    value={draft.prepareCommand ?? ""}
                    onChange={(event) => set("prepareCommand", event.target.value)}
                    placeholder="npm ci && npm run build"
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                {PERSIST_OPTIONS.map((option) => (
                  <Choice
                    key={option.id}
                    checked={(draft.sharedPaths ?? []).includes(option.path)}
                    onToggle={() => togglePersist(option.path)}
                    label={option.label}
                    hint={option.hint}
                  />
                ))}
              </div>
              {isReleasePresetId(draft.preset)
                ? RELEASE_PRESETS[draft.preset].persistHints
                    .filter((hint) => !PERSIST_OPTIONS.some((option) => option.path === hint.path))
                    .map((hint) => (
                      <Choice
                        key={hint.path}
                        checked={(draft.sharedPaths ?? []).includes(hint.path)}
                        onToggle={() => togglePersist(hint.path)}
                        label={hint.label}
                        hint={hint.path}
                      />
                    ))
                : null}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="grid gap-4 md:grid-cols-2">
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
            </div>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => setAdvanced((value) => !value)}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={advanced}
            >
              <ChevronDown className={`size-3.5 transition-transform ${advanced ? "rotate-180" : ""}`} />
              Advanced
            </button>
            {advanced ? (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <Field label="UID / GID" hint="Optional process owner inside the container.">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={65535}
                      value={draft.uid ?? ""}
                      onChange={(event) =>
                        set("uid", event.target.value ? Number(event.target.value) : undefined)
                      }
                      placeholder="UID"
                    />
                    <Input
                      type="number"
                      min={0}
                      max={65535}
                      value={draft.gid ?? ""}
                      onChange={(event) =>
                        set("gid", event.target.value ? Number(event.target.value) : undefined)
                      }
                      placeholder="GID"
                    />
                  </div>
                </Field>
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
                  label="Builder image"
                  hint="Optional. Leave blank to run the command inside the live app container."
                >
                  <Input
                    value={draft.builderImage ?? ""}
                    onChange={(event) => set("builderImage", event.target.value)}
                    placeholder="node:20-alpine"
                  />
                </Field>
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
                <Field
                  label="Builder cache paths"
                  hint="Comma separated repo paths mounted from persistent cache, such as node_modules and .next/cache."
                >
                  <Input
                    value={(draft.builderCachePaths ?? []).join(", ")}
                    onChange={(event) =>
                      set(
                        "builderCachePaths",
                        event.target.value
                          .split(",")
                          .map((part) => part.trim())
                          .filter(Boolean),
                      )
                    }
                    placeholder="node_modules, .next/cache, .npm"
                  />
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
            ) : null}
          </div>

          <ReleaseRecipeSummary config={payloadFromDraft(draft)} />

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep((value) => Math.max(0, value - 1))}
                disabled={step === 0}
                className="inline-flex h-10 items-center rounded-xl border border-border/60 bg-muted/20 px-3 text-sm font-medium text-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Back
              </button>
              {step < WIZARD_STEPS.length - 1 ? (
                <button
                  type="button"
                  onClick={() => setStep((value) => Math.min(WIZARD_STEPS.length - 1, value + 1))}
                  disabled={!canAdvance}
                  className="inline-flex h-10 items-center rounded-xl border border-border/60 bg-muted/20 px-3 text-sm font-medium text-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                !draft.containerPath.trim() ||
                (servicesData.services.length > 0 && !selectedServiceId && draft.enabled)
              }
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="size-4" />
              {saving ? "Saving…" : "Save recipe"}
            </button>
          </div>
        </div>
      ) : saved?.enabled ? (
        <div className="border-t border-border/40 px-5 py-4">
          <ReleaseRecipeSummary config={saved} compact />
        </div>
      ) : null}
    </section>
  );
}
