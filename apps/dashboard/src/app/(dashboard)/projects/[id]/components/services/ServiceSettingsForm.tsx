"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n } from "@/components/i18n-provider";
import ReadinessSection from "@/components/project-settings/ReadinessSection";
import {
  serviceKind,
  type Service,
  type ServiceInput,
  type ComposeAdvancedPatch,
  type ComposeHealthcheck,
  type OpenshipReadiness,
} from "@/lib/api/services";

/**
 * The service configuration form — extracted from the former ServiceEditorModal
 * so it lives inline in the Settings tab (no modal). Owns source/build, ports,
 * command, restart, healthcheck and the enabled toggle. Routing (public domain /
 * exposed port) is owned by the Domains tab and env by the Env tab, so saving
 * Settings never touches either.
 */

interface ServiceSettingsFormProps {
  service: Service;
  onSubmit: (data: Partial<ServiceInput>) => Promise<void>;
}

const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const joinList = (value?: string[] | null) => (value ?? []).join("\n");

export function ServiceSettingsForm({ service, onSubmit }: ServiceSettingsFormProps) {
  const { t } = useI18n();
  const f = t.projectDetail.services.settingsForm;
  const isMonorepo = serviceKind(service) === "monorepo";

  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"image" | "build">("image");
  const [image, setImage] = useState("");
  const [build, setBuild] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  const [ports, setPorts] = useState("");
  const [dependsOn, setDependsOn] = useState("");
  const [volumes, setVolumes] = useState("");
  const [command, setCommand] = useState("");
  const [restart, setRestart] = useState("unless-stopped");
  const [hcTest, setHcTest] = useState("");
  const [hcInterval, setHcInterval] = useState("");
  const [hcTimeout, setHcTimeout] = useState("");
  const [hcRetries, setHcRetries] = useState("");
  const [hcStartPeriod, setHcStartPeriod] = useState("");
  /** Per-service readiness gate. undefined = inherit the project's (which is
   *  itself off by default). */
  const [readiness, setReadiness] = useState<OpenshipReadiness | undefined>(undefined);
  const [enabled, setEnabled] = useState(true);
  const [rootDirectory, setRootDirectory] = useState("");
  const [framework, setFramework] = useState("");
  const [packageManager, setPackageManager] = useState("");
  const [buildImage, setBuildImage] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the selected service changes (the panel reuses this instance
  // across service switches since it sits at the same position in the tree).
  useEffect(() => {
    setName(service.name ?? "");
    setSourceType(service.build || service.dockerfile ? "build" : "image");
    setImage(service.image ?? "");
    setBuild(service.build ?? "");
    setDockerfile(service.dockerfile ?? "");
    setPorts(joinList(service.ports));
    setDependsOn(joinList(service.dependsOn));
    setVolumes(joinList(service.volumes));
    setCommand(service.command ?? "");
    setRestart(service.restart ?? "unless-stopped");
    const hc = service.advanced?.healthcheck;
    setHcTest(hc ? (Array.isArray(hc.test) ? hc.test.join(" ") : hc.test ?? "") : "");
    setHcInterval(hc?.interval ?? "");
    setHcTimeout(hc?.timeout ?? "");
    setHcRetries(hc?.retries != null ? String(hc.retries) : "");
    setHcStartPeriod(hc?.startPeriod ?? "");
    setReadiness(service.advanced?.readiness);
    setEnabled(service.enabled ?? true);
    setRootDirectory(service.rootDirectory ?? "");
    setFramework(service.framework ?? "");
    setPackageManager(service.packageManager ?? "");
    setBuildImage(service.buildImage ?? "");
    setInstallCommand(service.installCommand ?? "");
    setBuildCommand(service.buildCommand ?? "");
    setStartCommand(service.startCommand ?? "");
    setOutputDirectory(service.outputDirectory ?? "");
    setError(null);
    setSaving(false);
  }, [service]);

  const portList = useMemo(() => splitList(ports), [ports]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setError(f.errors.nameRequired);
      return;
    }

    if (!isMonorepo) {
      if (sourceType === "image" && !image.trim()) {
        setError(f.errors.imageOrDockerfile);
        return;
      }
      if (sourceType === "build" && !build.trim() && !dockerfile.trim()) {
        setError(f.errors.buildContextOrDockerfile);
        return;
      }
    } else {
      if (!rootDirectory.trim()) {
        setError(f.errors.rootDirectory);
        return;
      }
      if (!buildCommand.trim() && !startCommand.trim()) {
        setError(f.errors.buildOrStart);
        return;
      }
    }

    setSaving(true);
    setError(null);

    /**
     * Only the two keys this form owns. `advanced` is MERGED server-side, so the
     * keys we don't mention (`files` from an app template, per-service `resources`)
     * are preserved without being echoed back — and an explicit `null` is how we
     * say "the user cleared this one".
     */
    const buildAdvanced = (): ComposeAdvancedPatch => {
      const test = hcTest.trim();
      let healthcheck: ComposeHealthcheck | null = null;
      if (test) {
        healthcheck = { test };
        if (hcInterval.trim()) healthcheck.interval = hcInterval.trim();
        if (hcTimeout.trim()) healthcheck.timeout = hcTimeout.trim();
        if (hcStartPeriod.trim()) healthcheck.startPeriod = hcStartPeriod.trim();
        const retries = Number(hcRetries);
        if (hcRetries.trim() && Number.isInteger(retries) && retries >= 0) {
          healthcheck.retries = retries;
        }
      }
      return { healthcheck, readiness: readiness ?? null };
    };

    // Environment is intentionally omitted — it's owned by the Env tab, so this
    // PATCH must not clobber it.
    const payload: Partial<ServiceInput> = isMonorepo
      ? {
          name: trimmedName,
          image: "",
          build: "",
          dockerfile: "",
          ports: portList,
          dependsOn: splitList(dependsOn),
          volumes: splitList(volumes),
          command: "",
          restart,
          enabled,
          rootDirectory: rootDirectory.trim(),
          framework: framework.trim() || undefined,
          packageManager: packageManager.trim() || undefined,
          buildImage: buildImage.trim() || undefined,
          installCommand: installCommand.trim() || undefined,
          buildCommand: buildCommand.trim() || undefined,
          startCommand: startCommand.trim() || undefined,
          outputDirectory: outputDirectory.trim() || undefined,
        }
      : {
          name: trimmedName,
          image: sourceType === "image" ? image.trim() : "",
          build: sourceType === "build" ? build.trim() || "." : "",
          dockerfile: sourceType === "build" ? dockerfile.trim() : "",
          ports: portList,
          dependsOn: splitList(dependsOn),
          volumes: splitList(volumes),
          command: command.trim(),
          restart,
          advanced: buildAdvanced(),
          enabled,
        };

    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : f.errors.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="bg-card rounded-2xl border border-border/50 p-6 space-y-5">
        <Field label={f.name}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="web"
            className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
          />
        </Field>

        {isMonorepo ? (
          <div className="space-y-3">
            <Field label={f.rootDirectory}>
              <input
                value={rootDirectory}
                onChange={(event) => setRootDirectory(event.target.value)}
                placeholder="apps/web"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={f.framework}>
                <input
                  value={framework}
                  onChange={(event) => setFramework(event.target.value)}
                  placeholder="nextjs"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                />
              </Field>
              <Field label={f.packageManager}>
                <input
                  value={packageManager}
                  onChange={(event) => setPackageManager(event.target.value)}
                  placeholder="pnpm"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                />
              </Field>
            </div>
            <Field label={f.buildImage}>
              <input
                value={buildImage}
                onChange={(event) => setBuildImage(event.target.value)}
                placeholder="node:22"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
              />
            </Field>
            <Field label={f.installCommand}>
              <input
                value={installCommand}
                onChange={(event) => setInstallCommand(event.target.value)}
                placeholder="pnpm install --frozen-lockfile"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
              />
            </Field>
            <Field label={f.buildCommand}>
              <input
                value={buildCommand}
                onChange={(event) => setBuildCommand(event.target.value)}
                placeholder="pnpm build"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
              />
            </Field>
            <Field label={f.startCommand}>
              <input
                value={startCommand}
                onChange={(event) => setStartCommand(event.target.value)}
                placeholder="pnpm start"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
              />
            </Field>
            <Field label={f.outputDirectory}>
              <input
                value={outputDirectory}
                onChange={(event) => setOutputDirectory(event.target.value)}
                placeholder=".next"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
              />
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSourceType("image")}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  sourceType === "image"
                    ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                }`}
              >
                {f.image}
              </button>
              <button
                type="button"
                onClick={() => setSourceType("build")}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  sourceType === "build"
                    ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                }`}
              >
                {f.dockerfile}
              </button>
            </div>

            {sourceType === "image" ? (
              <Field label={f.image}>
                <input
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  placeholder="postgres:16"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                />
              </Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={f.buildContext}>
                  <input
                    value={build}
                    onChange={(event) => setBuild(event.target.value)}
                    placeholder="."
                    className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                  />
                </Field>
                <Field label={f.dockerfile}>
                  <input
                    value={dockerfile}
                    onChange={(event) => setDockerfile(event.target.value)}
                    placeholder="Dockerfile"
                    className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                  />
                </Field>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={f.ports}>
            <textarea
              value={ports}
              onChange={(event) => setPorts(event.target.value)}
              placeholder={"3000\n8080:80"}
              rows={3}
              className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={f.dependsOn}>
            <textarea
              value={dependsOn}
              onChange={(event) => setDependsOn(event.target.value)}
              placeholder={"db\nredis"}
              rows={3}
              className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>

        <div className={`grid gap-3 ${isMonorepo ? "sm:grid-cols-1" : "sm:grid-cols-2"}`}>
          {!isMonorepo && (
            <Field label={f.command}>
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npm start"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              />
            </Field>
          )}
          <Field label={f.restartPolicy}>
            <select
              value={restart}
              onChange={(event) => setRestart(event.target.value)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            >
              <option value="unless-stopped">unless-stopped</option>
              <option value="always">always</option>
              <option value="on-failure">on-failure</option>
              <option value="no">no</option>
            </select>
          </Field>
        </div>

        <Field label={f.volumes}>
          <textarea
            value={volumes}
            onChange={(event) => setVolumes(event.target.value)}
            placeholder={"pgdata:/var/lib/postgresql/data"}
            rows={2}
            className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
          />
        </Field>

        {!isMonorepo && (
          <Field label={f.healthcheck}>
            <input
              value={hcTest}
              onChange={(event) => setHcTest(event.target.value)}
              placeholder="curl -f http://localhost:3000/health || exit 1"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {f.healthcheckHint}
            </p>
            {hcTest.trim() && (
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                <input
                  value={hcInterval}
                  onChange={(event) => setHcInterval(event.target.value)}
                  placeholder="interval 30s"
                  className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                />
                <input
                  value={hcTimeout}
                  onChange={(event) => setHcTimeout(event.target.value)}
                  placeholder="timeout 10s"
                  className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                />
                <input
                  value={hcRetries}
                  onChange={(event) => setHcRetries(event.target.value)}
                  placeholder="retries 3"
                  inputMode="numeric"
                  className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                />
                <input
                  value={hcStartPeriod}
                  onChange={(event) => setHcStartPeriod(event.target.value)}
                  placeholder="start 40s"
                  className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                />
              </div>
            )}
          </Field>
        )}

        {/* Deploy-time readiness gate for THIS service, overriding the project's.
            Collapsed and off unless opened — the field above is the daemon-run
            HEALTHCHECK (custom command, on a loop); this is the pipeline's one-shot
            "did it come up?", and the only one that can fail a deploy. */}
        <ReadinessSection value={readiness} onChange={setReadiness} />

        <label
          htmlFor="service-enabled"
          className="flex items-center justify-between rounded-2xl border border-border/50 bg-muted/10 px-4 py-3 cursor-pointer"
        >
          <span>
            <span className="block text-sm font-medium text-foreground">{f.enabled}</span>
            <span className="text-xs text-muted-foreground">{f.enabledHint}</span>
          </span>
          <Checkbox id="service-enabled" checked={enabled} onCheckedChange={setEnabled} aria-label={f.enabled} />
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {f.saveChanges}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export default ServiceSettingsForm;
