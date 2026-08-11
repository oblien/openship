"use client";

import React, { useEffect, useState } from "react";
import { Box, HeartPulse, Loader2, Network, Package, Save, Terminal, type LucideIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { TagListInput, ChipMultiSelect } from "@/components/ui/TagListInput";
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
 *
 * The fields are grouped into labeled `SectionCard`s (General · Source ·
 * Networking · Runtime · Health) — the same static-card idiom the Advanced/Build
 * settings tabs use — so the form reads as scannable contexts instead of one flat
 * wall of inputs. Source shows BOTH an image field and a build context/Dockerfile
 * below an "or build from source" divider; whichever is filled wins, with build
 * beating a stale image (see the payload's `useBuild`).
 */

interface ServiceSettingsFormProps {
  service: Service;
  /** Names of the OTHER services in this project, for the depends-on picker. */
  siblingServiceNames?: string[];
  onSubmit: (data: Partial<ServiceInput>) => Promise<void>;
}

/** Backend per-item caps (service.schema.ts ComposeFieldsBlock) surfaced here so
 *  the structured editor stops the user before a PATCH would be rejected. */
const MAX_ITEMS = 50;
const PORT_MAX = 100;
const VOLUME_MAX = 500;

/** Shared input chrome — one definition so every field reads identically. */
const INPUT =
  "h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40";
/** Compact variant for the healthcheck timing row. */
const INPUT_SM =
  "h-10 w-full rounded-xl border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40";

const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export function ServiceSettingsForm({ service, siblingServiceNames = [], onSubmit }: ServiceSettingsFormProps) {
  const { t } = useI18n();
  const f = t.projectDetail.services.settingsForm;
  const isMonorepo = serviceKind(service) === "monorepo";

  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [build, setBuild] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  // Committed chips + the in-progress draft, kept separate so the draft can be
  // folded in at submit (see handleSubmit) without losing un-Entered text.
  const [portsTags, setPortsTags] = useState<string[]>([]);
  const [portsDraft, setPortsDraft] = useState("");
  const [volumesTags, setVolumesTags] = useState<string[]>([]);
  const [volumesDraft, setVolumesDraft] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [restart, setRestart] = useState("unless-stopped");
  /** Custom east-west DNS alias (advanced.alias) resolving alongside the
   *  service name. Empty = default (service name only). */
  const [alias, setAlias] = useState("");
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
    setImage(service.image ?? "");
    setBuild(service.build ?? "");
    setDockerfile(service.dockerfile ?? "");
    setPortsTags(service.ports ?? []);
    setPortsDraft("");
    setVolumesTags(service.volumes ?? []);
    setVolumesDraft("");
    setDependsOn(service.dependsOn ?? []);
    setCommand(service.command ?? "");
    setRestart(service.restart ?? "unless-stopped");
    setAlias(service.advanced?.alias ?? "");
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

  // Fold any un-committed draft into the chip list (same split/trim/drop-empty
  // as the old textarea) so text typed without pressing Enter is still saved.
  const portList = [...portsTags, ...splitList(portsDraft)];
  const volumeList = [...volumesTags, ...splitList(volumesDraft)];

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setError(f.errors.nameRequired);
      return;
    }

    if (!isMonorepo) {
      // Show-both source: valid as long as ONE of image or a build context /
      // Dockerfile is set. No mode toggle to disagree with.
      if (!image.trim() && !build.trim() && !dockerfile.trim()) {
        setError(f.errors.imageOrDockerfile);
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
      // Empty → null so a cleared alias removes the stored key (mergeAdvanced
      // treats null as "delete"). Server normalizes + collision-checks it.
      return { healthcheck, readiness: readiness ?? null, alias: alias.trim() || null };
    };

    // Show-both source resolution: a build context or Dockerfile means "build
    // from source" and WINS over a stale image field; otherwise it's a pulled
    // image. Exactly one of the two is persisted so the deploy path is never
    // ambiguous.
    const useBuild = !!(build.trim() || dockerfile.trim());

    // Environment is intentionally omitted — it's owned by the Env tab, so this
    // PATCH must not clobber it.
    const payload: Partial<ServiceInput> = isMonorepo
      ? {
          name: trimmedName,
          image: "",
          build: "",
          dockerfile: "",
          ports: portList,
          dependsOn,
          volumes: volumeList,
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
          // Only the alias — the healthcheck/readiness inputs aren't rendered for
          // a monorepo sub-app, so sending buildAdvanced() here would MERGE a null
          // healthcheck and wipe one set elsewhere. `advanced` is merged
          // server-side, so this touches nothing but the alias.
          advanced: { alias: alias.trim() || null },
        }
      : {
          name: trimmedName,
          image: useBuild ? "" : image.trim(),
          build: useBuild ? build.trim() || "." : "",
          dockerfile: useBuild ? dockerfile.trim() : "",
          ports: portList,
          dependsOn,
          volumes: volumeList,
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

      <SectionCard icon={Box} title={f.sections.general} description={f.sections.generalHint}>
        <Field label={f.name}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="web"
            className={INPUT}
          />
        </Field>

        <label
          htmlFor="service-enabled"
          className="flex cursor-pointer items-center justify-between rounded-xl border border-border/50 bg-muted/20 px-4 py-3 transition-colors hover:bg-muted/40"
        >
          <span>
            <span className="block text-sm font-medium text-foreground">{f.enabled}</span>
            <span className="text-xs text-muted-foreground">{f.enabledHint}</span>
          </span>
          <Checkbox id="service-enabled" checked={enabled} onCheckedChange={setEnabled} aria-label={f.enabled} />
        </label>
      </SectionCard>

      <SectionCard
        icon={Package}
        title={f.sections.source}
        description={isMonorepo ? f.sections.sourceMonorepoHint : f.sections.sourceHint}
      >
        {isMonorepo ? (
          <>
            <Field label={f.rootDirectory}>
              <input
                value={rootDirectory}
                onChange={(event) => setRootDirectory(event.target.value)}
                placeholder="apps/web"
                className={`${INPUT} font-mono`}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={f.framework}>
                <input
                  value={framework}
                  onChange={(event) => setFramework(event.target.value)}
                  placeholder="nextjs"
                  className={INPUT}
                />
              </Field>
              <Field label={f.packageManager}>
                <input
                  value={packageManager}
                  onChange={(event) => setPackageManager(event.target.value)}
                  placeholder="pnpm"
                  className={INPUT}
                />
              </Field>
            </div>
            <Field label={f.buildImage}>
              <input
                value={buildImage}
                onChange={(event) => setBuildImage(event.target.value)}
                placeholder="node:22"
                className={`${INPUT} font-mono`}
              />
            </Field>
            <Field label={f.installCommand}>
              <input
                value={installCommand}
                onChange={(event) => setInstallCommand(event.target.value)}
                placeholder="pnpm install --frozen-lockfile"
                className={`${INPUT} font-mono`}
              />
            </Field>
            <Field label={f.buildCommand}>
              <input
                value={buildCommand}
                onChange={(event) => setBuildCommand(event.target.value)}
                placeholder="pnpm build"
                className={`${INPUT} font-mono`}
              />
            </Field>
            <Field label={f.startCommand}>
              <input
                value={startCommand}
                onChange={(event) => setStartCommand(event.target.value)}
                placeholder="pnpm start"
                className={`${INPUT} font-mono`}
              />
            </Field>
            <Field label={f.outputDirectory}>
              <input
                value={outputDirectory}
                onChange={(event) => setOutputDirectory(event.target.value)}
                placeholder=".next"
                className={`${INPUT} font-mono`}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={f.image}>
              <input
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="postgres:16"
                className={INPUT}
              />
              <p className="mt-1 text-xs text-muted-foreground">{f.imageHint}</p>
            </Field>

            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border/50" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {f.orBuildFromSource}
              </span>
              <span className="h-px flex-1 bg-border/50" />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={f.buildContext}>
                <input
                  value={build}
                  onChange={(event) => setBuild(event.target.value)}
                  placeholder="."
                  className={INPUT}
                />
              </Field>
              <Field label={f.dockerfile}>
                <input
                  value={dockerfile}
                  onChange={(event) => setDockerfile(event.target.value)}
                  placeholder="Dockerfile"
                  className={INPUT}
                />
              </Field>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard icon={Network} title={f.sections.networking} description={f.sections.networkingHint}>
        <FieldBlock label={f.ports}>
          <TagListInput
            tags={portsTags}
            draft={portsDraft}
            onTagsChange={setPortsTags}
            onDraftChange={setPortsDraft}
            placeholder="3000 · 8080:80"
            maxItems={MAX_ITEMS}
            maxLength={PORT_MAX}
            ariaLabel={f.ports}
            removeLabel={f.removeTag}
          />
          <p className="mt-1 text-xs text-muted-foreground">{f.portsHint}</p>
        </FieldBlock>

        {/* Custom east-west DNS alias applies to every service kind — a monorepo
            sub-app joins the same per-project network and is reached by the same
            alias mechanism (createServiceRuntimeConfig → aliasExtras), so the field
            is no longer gated to compose. */}
        <Field label={f.alias}>
          <input
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder={name.trim() || "db"}
            className={`${INPUT} font-mono`}
          />
          <p className="mt-1 text-xs text-muted-foreground">{f.aliasHint}</p>
        </Field>

        <FieldBlock label={f.dependsOn}>
          <ChipMultiSelect
            value={dependsOn}
            options={siblingServiceNames}
            onChange={setDependsOn}
            emptyLabel={f.dependsOnEmpty}
          />
          <p className="mt-1 text-xs text-muted-foreground">{f.dependsOnHint}</p>
        </FieldBlock>
      </SectionCard>

      <SectionCard icon={Terminal} title={f.sections.runtime} description={f.sections.runtimeHint}>
        <div className={`grid gap-3 ${isMonorepo ? "sm:grid-cols-1" : "sm:grid-cols-2"}`}>
          {!isMonorepo && (
            <Field label={f.command}>
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npm start"
                className={INPUT}
              />
            </Field>
          )}
          <Field label={f.restartPolicy}>
            <select
              value={restart}
              onChange={(event) => setRestart(event.target.value)}
              className={INPUT}
            >
              <option value="unless-stopped">unless-stopped</option>
              <option value="always">always</option>
              <option value="on-failure">on-failure</option>
              <option value="no">no</option>
            </select>
          </Field>
        </div>

        <FieldBlock label={f.volumes}>
          <TagListInput
            tags={volumesTags}
            draft={volumesDraft}
            onTagsChange={setVolumesTags}
            onDraftChange={setVolumesDraft}
            placeholder="pgdata:/var/lib/postgresql/data"
            maxItems={MAX_ITEMS}
            maxLength={VOLUME_MAX}
            ariaLabel={f.volumes}
            removeLabel={f.removeTag}
          />
          <p className="mt-1 text-xs text-muted-foreground">{f.volumesHint}</p>
        </FieldBlock>
      </SectionCard>

      <SectionCard icon={HeartPulse} title={f.sections.health} description={f.sections.healthHint}>
        {!isMonorepo && (
          <Field label={f.healthcheck}>
            <input
              value={hcTest}
              onChange={(event) => setHcTest(event.target.value)}
              placeholder="curl -f http://localhost:3000/health || exit 1"
              className={INPUT}
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
                  className={INPUT_SM}
                />
                <input
                  value={hcTimeout}
                  onChange={(event) => setHcTimeout(event.target.value)}
                  placeholder="timeout 10s"
                  className={INPUT_SM}
                />
                <input
                  value={hcRetries}
                  onChange={(event) => setHcRetries(event.target.value)}
                  placeholder="retries 3"
                  inputMode="numeric"
                  className={INPUT_SM}
                />
                <input
                  value={hcStartPeriod}
                  onChange={(event) => setHcStartPeriod(event.target.value)}
                  placeholder="start 40s"
                  className={INPUT_SM}
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
      </SectionCard>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {f.saveChanges}
        </button>
      </div>
    </form>
  );
}

/** A titled settings section — the local SectionCard idiom shared by every
 *  project-settings tab (AdvancedSettings/BuildSettings): an icon chip + title +
 *  description header over a padded body. Groups the flat form into scannable
 *  contexts. */
function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Icon className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Like Field but a plain block — for editors made of buttons/chips, where a
 *  wrapping <label> would forward stray clicks to the first control inside. */
function FieldBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[12px] font-medium text-foreground">{label}</span>
      {children}
    </div>
  );
}

export default ServiceSettingsForm;
