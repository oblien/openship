"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import Link from "next/link";
import { RepositoryBuildFields } from "./RepositoryBuildFields";
import { repositoryBuildFields, type ServiceRepositorySource } from "./repository-source";
import { getApiRequestScopeVersion } from "@/lib/api/client";
import type { ImageCatalogEntry } from "@/lib/api/images";
import type { ServiceInput } from "@/lib/api/services";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { defaultDomainType } from "@/lib/default-domain-type";
import { getApiErrorMessage } from "@/lib/api";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import { LOCAL_SERVICE_CATALOG } from "./local-service-catalog";
import { ProjectConnectionForm } from "../UseInProjectModal";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface AddServiceModalProps {
  open: boolean;
  projectId?: string;
  projectName: string;
  // A self-hosted dashboard can also manage a managed Cloud project.
  isCloudProject?: boolean;
  repository?: ServiceRepositorySource | null;
  onClose: () => void;
  onSubmit: (data: ServiceInput) => Promise<void>;
}

type EnvRow = { key: string; value: string; visible: boolean };

// Custom image sentinel; the source selector opens its form directly.
const CUSTOM_ENTRY: ImageCatalogEntry = {
  id: "__custom__",
  name: "Custom image",
  description: "Pull any public or private Docker image by tag.",
};

function isCustom(entry: ImageCatalogEntry | null): boolean {
  return entry?.id === CUSTOM_ENTRY.id;
}

function envObjectFromRows(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

function envRowsFromCatalog(entry: ImageCatalogEntry | null): EnvRow[] {
  if (!entry?.defaultEnv?.length) return [];
  // Service env vars are mostly knobs (DB names, ports, feature flags) - not
  // secrets - so they default to visible. The user can still toggle a row
  // off per-value if it's sensitive (e.g. an admin password).
  return entry.defaultEnv.map((e) => ({
    key: e.key,
    value:
      e.generate === "secret"
        ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("")
        : (e.value ?? ""),
    visible: e.generate !== "secret",
  }));
}

type VolumeRow = { name: string; path: string };

/** Parse a catalog "name:path" string into the structured row shape used by the UI. */
function parseVolumeString(raw: string): VolumeRow | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const name = raw.slice(0, i).trim();
  const path = raw.slice(i + 1).trim();
  if (!name || !path) return null;
  return { name, path };
}

function volumeRowsFromCatalog(entry: ImageCatalogEntry | null): VolumeRow[] {
  if (!entry?.defaultVolumes?.length) return [];
  return entry.defaultVolumes.map(parseVolumeString).filter((r): r is VolumeRow => r !== null);
}

function volumeStringsFromRows(rows: VolumeRow[]): string[] {
  return rows
    .map((r) => ({ name: r.name.trim(), path: r.path.trim() }))
    .filter((r) => r.name && r.path)
    .map((r) => `${r.name}:${r.path}`);
}

/* ─── Curated categories ───────────────────────────────────────────────────
 *
 * App companion services (databases, caches, queues, etc.) bucketed into
 * predefined groups instead of whatever raw strings Oblien returns. Each
 * group has its own icon. Bucketing runs against the entry's `category`
 * field, then its `tags`, then keywords in the image string itself - so
 * we handle several plausible upstream shapes without needing the catalog
 * to use our exact labels.
 *
 * `Other` is a catch-all; we only render it when there's actually content.
 * Anything in "Other" still appears in "All".
 */

interface CategoryDef {
  id: string;
  label: string;
  icon: IconName;
  /** Substrings (lowercased) - match against category, tags, name, image. */
  match: string[];
}

const CATEGORIES: CategoryDef[] = [
  {
    id: "database",
    label: "Databases",
    icon: "database",
    match: [
      "database",
      "db",
      "sql",
      "postgres",
      "mysql",
      "mariadb",
      "mongo",
      "cockroach",
      "neon",
      "sqlite",
    ],
  },
  {
    id: "cache",
    label: "Caches",
    icon: "bolt",
    match: ["cache", "redis", "memcached", "dragonfly", "keydb"],
  },
  {
    id: "search",
    label: "Search",
    icon: "search",
    match: ["search", "elastic", "opensearch", "meilisearch", "typesense", "solr"],
  },
  {
    id: "vector",
    label: "Vector & AI",
    icon: "sparkles",
    match: [
      "vector",
      "qdrant",
      "weaviate",
      "milvus",
      "chroma",
      "pgvector",
      "embedding",
      "llm",
      "ollama",
    ],
  },
  {
    id: "queue",
    label: "Queues & Streams",
    icon: "message",
    match: ["queue", "broker", "rabbitmq", "kafka", "nats", "pulsar", "redpanda", "mqtt"],
  },
  {
    id: "storage",
    label: "Object Storage",
    icon: "hard-drive",
    match: ["storage", "minio", "s3", "garage", "seaweedfs", "ceph"],
  },
  {
    id: "auth",
    label: "Auth & Identity",
    icon: "shield-check",
    match: ["auth", "identity", "keycloak", "authentik", "oauth", "oidc"],
  },
  {
    id: "mail",
    label: "Mail & SMTP",
    icon: "mail",
    match: ["mail", "smtp", "mailpit", "mailhog", "smtp4dev", "postal"],
  },
  {
    id: "runtime",
    label: "Runtimes",
    icon: "rocket",
    match: ["runtime", "node", "python", "deno", "bun", "go", "ruby", "php"],
  },
];

const OTHER_CATEGORY_ID = "other";

// Keep service families recognizable without turning each catalog tile into
// a competing action button. These are presentation colors, not capabilities.
const CATEGORY_ACCENTS: Record<string, string> = {
  database: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  cache: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  search: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  vector: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  queue: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  storage: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  auth: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  mail: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  runtime: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
};

/**
 * Bucket a catalog entry into one of the curated categories. Walks
 * (category → tags → name → image) and returns the first match. Falls
 * through to "other" so nothing is hidden.
 */
function bucketEntry(entry: ImageCatalogEntry): string {
  const hints = [entry.category, ...(entry.tags ?? []), entry.id, entry.name, entry.image];
  for (const hint of hints) {
    if (!hint) continue;
    const text = hint.toLowerCase();
    for (const cat of CATEGORIES) {
      if (
        cat.id === text ||
        cat.label.toLowerCase() === text ||
        cat.match.some((kw) => text.includes(kw))
      )
        return cat.id;
    }
  }
  return OTHER_CATEGORY_ID;
}

function CatalogIcon({
  entry,
  className = "size-5",
}: {
  entry: ImageCatalogEntry;
  className?: string;
}) {
  const [failedLogo, setFailedLogo] = useState<string>();
  if (entry.logo && failedLogo !== entry.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={entry.logo}
        alt=""
        className={`${className} object-contain`}
        onError={() => setFailedLogo(entry.logo)}
      />
    );
  }
  const Icon = CATEGORIES.find((category) => category.id === bucketEntry(entry))?.icon ?? "window";
  return <UiIcon name={Icon} className={className} />;
}

export function AddServiceModal(props: AddServiceModalProps) {
  const resourceKey = useCloudResourceKey();
  // Source/destination changes must not reuse a different project's draft.
  return (
    <AddServiceForm
      key={JSON.stringify([props.open, props.projectId, props.repository, resourceKey])}
      {...props}
    />
  );
}

function AddServiceForm({
  open,
  projectId,
  projectName,
  isCloudProject,
  repository,
  onClose,
  onSubmit,
}: AddServiceModalProps) {
  const { t } = useI18n();
  const { deployMode } = usePlatform();
  const cloud = useCloud();
  const newEndpointDomainType = defaultDomainType(cloud.connected);
  const cloudOnly = deployMode === "cloud" || !!isCloudProject;

  // Step state - "pick" shows the catalog, "configure" shows the form.
  const [step, setStep] = useState<"pick" | "configure">("pick");
  const [sourceMode, setSourceMode] = useState<"catalog" | "repository" | "image" | "existing">(
    "catalog",
  );
  const [buildContext, setBuildContext] = useState(".");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const scope = useRef(getApiRequestScopeVersion());
  const [selected, setSelected] = useState<ImageCatalogEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Catalog category is a compact filter, available at every screen size.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // Every application service uses the shared Docker engine and OCI catalog.
  const catalog = cloudOnly
    ? LOCAL_SERVICE_CATALOG.filter((entry) => !entry.gpus && entry.supportsCloud !== false)
    : LOCAL_SERVICE_CATALOG;

  // Configure step state. Ports is a single-line, comma-separated string -
  // 95% of services have one port and the old textarea wasted vertical space.
  // Volumes is a structured pair list so the user doesn't have to learn the
  // `name:path` compose syntax on first contact.
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState<string>("");
  const [volumeRows, setVolumeRows] = useState<Array<{ name: string; path: string }>>([]);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [exposed, setExposed] = useState(false);
  const [exposedPort, setExposedPort] = useState("");
  const [domain, setDomain] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [domainType, setDomainType] = useState<"free" | "custom">(newEndpointDomainType);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // The keyed form owns draft lifetime. Capture request scope after parent
  // layout effects have established the account used by API calls.
  useEffect(() => {
    scope.current = getApiRequestScopeVersion();
  }, []);

  // Bucket every catalog entry once into a curated category. We memoize
  // the assignments so search/filter doesn't re-run bucketEntry per render.
  const bucketed = useMemo(() => {
    return catalog.map((entry) => ({ entry, bucket: bucketEntry(entry) }));
  }, [catalog]);

  // Counts per curated category - only includes buckets that actually have
  // entries, in curated order. "Other"
  // is appended at the end if it has anything.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { bucket } of bucketed) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const catLabels = t.projectDetail.services.addModal.categories as Record<string, string>;
    const ordered: Array<{ id: string; label: string; icon: IconName; count: number }> = [];
    for (const cat of CATEGORIES) {
      const count = counts.get(cat.id) ?? 0;
      if (count > 0)
        ordered.push({ id: cat.id, label: catLabels[cat.id] ?? cat.label, icon: cat.icon, count });
    }
    const otherCount = counts.get(OTHER_CATEGORY_ID) ?? 0;
    if (otherCount > 0) {
      ordered.push({
        id: OTHER_CATEGORY_ID,
        label: catLabels.other,
        icon: "window",
        count: otherCount,
      });
    }
    return ordered;
  }, [bucketed, t]);

  // Filter the catalog by active category and search query.
  const visibleCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return bucketed
      .filter(({ entry, bucket }) => {
        if (activeCategory) {
          if (bucket !== activeCategory) return false;
        }
        if (!q) return true;
        const fields = [entry.name, entry.description, entry.image, entry.category]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return fields.includes(q);
      })
      .map(({ entry }) => entry);
  }, [bucketed, searchQuery, activeCategory]);

  const handlePick = (entry: ImageCatalogEntry, resetDraft = false) => {
    if (!resetDraft && entry.id === selected?.id) {
      setStep("configure");
      return;
    }
    setSelected(entry);
    // A different service/source starts a new draft, including public exposure.
    setExposed(false);
    setExposedPort("");
    setDomain("");
    setCustomDomain("");
    setDomainType(newEndpointDomainType);
    setBuildContext(".");
    setDockerfile("Dockerfile");
    // Seed configure step from catalog defaults. Custom image gets blank fields.
    if (isCustom(entry)) {
      setName("");
      setImage("");
      setPorts("");
      setVolumeRows([]);
      setEnvRows([]);
    } else {
      const seedName = (entry.id ?? entry.name ?? "")
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      setName(seedName || "");
      setImage(entry.image ?? "");
      // Ports now lives on a single line - commas are the user-friendly separator.
      setPorts((entry.ports ?? []).map((p) => String(p)).join(", "));
      setVolumeRows(volumeRowsFromCatalog(entry));
      setEnvRows(envRowsFromCatalog(entry));
    }
    setError(null);
    setStep("configure");
  };

  const handleBackToCatalog = () => {
    setStep("pick");
    // Don't wipe form state - if the user clicks back into the same tile they
    // shouldn't lose what they typed.
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || scope.current !== getApiRequestScopeVersion()) return;

    const trimmedName = name.trim();
    const trimmedImage = image.trim();

    if (!trimmedName) {
      setError(t.projectDetail.services.addModal.serviceNameRequired);
      return;
    }
    if (sourceMode !== "repository" && !trimmedImage) {
      setError(t.projectDetail.services.addModal.imageRequired);
      return;
    }

    let buildFields = { build: "", dockerfile: "" };
    if (sourceMode === "repository") {
      if (!repository) {
        setError(t.projectDetail.services.addModal.repositorySource.noRepository);
        return;
      }
      const fields = repositoryBuildFields(repository, buildContext, dockerfile);
      if (typeof fields === "string") {
        setError(t.projectDetail.services.addModal.repositorySource[fields]);
        return;
      }
      buildFields = fields;
    }

    submitting.current = true;
    setSaving(true);
    setError(null);

    const portList = ports
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    const volumeList = volumeStringsFromRows(volumeRows);

    const payload: ServiceInput = {
      name: trimmedName,
      image: sourceMode === "repository" ? "" : trimmedImage,
      ...buildFields,
      ports: portList,
      dependsOn: [],
      environment: envObjectFromRows(envRows),
      volumes: volumeList,
      command: "",
      // A custom replacement image must not inherit another image's entrypoint
      // arguments. Matching catalog images keep argv intact (never `sh -c`).
      ...(trimmedImage === selected?.image && selected.commandArgv
        ? { commandArgv: [...selected.commandArgv] }
        : {}),
      // A catalog entry that needs a GPU (the Ollama GPU variant) carries its
      // request; a replacement image keeps nothing, like commandArgv above.
      ...(trimmedImage === selected?.image && selected.gpus
        ? { advanced: { gpus: { ...selected.gpus } } }
        : {}),
      restart: "unless-stopped",
      enabled: true,
      exposed,
      exposedPort: exposed ? exposedPort.trim() || undefined : undefined,
      domain: exposed && domainType === "free" ? domain.trim() || undefined : undefined,
      customDomain:
        exposed && domainType === "custom" ? customDomain.trim() || undefined : undefined,
      domainType,
    };

    try {
      await onSubmit(payload);
      if (scope.current === getApiRequestScopeVersion()) onClose();
    } catch (err) {
      if (scope.current === getApiRequestScopeVersion())
        setError(getApiErrorMessage(err, t.projectDetail.services.addModal.addServiceFailed));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      closable={!saving}
      showCloseButton={false}
      maxWidth="920px"
      width="100%"
      maxHeight="90vh"
      surface="frosted"
      overflow="hidden"
    >
      <div className="flex max-h-[90vh] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-5">
          <div className="flex items-center gap-3 min-w-0">
            {sourceMode === "catalog" && step === "configure" && (
              <button
                type="button"
                disabled={saving}
                onClick={handleBackToCatalog}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={t.projectDetail.services.addModal.backToCatalog}
              >
                <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground truncate">
                {step === "pick" || sourceMode !== "catalog"
                  ? t.projectDetail.services.addModal.addTitle
                  : interpolate(t.projectDetail.services.addModal.configureTitle, {
                      name: selected?.name ?? t.projectDetail.services.addModal.fallbackService,
                    })}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {sourceMode === "existing"
                  ? t.projects.connections.existingHint
                  : step === "pick"
                    ? t.projectDetail.services.addModal.repositorySource.subtitle
                    : t.projectDetail.services.addModal.configureSubtitle}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label={t.projectDetail.services.addModal.close}
            >
              <UiIcon name="close" className="size-4" />
            </button>
          </div>
        </div>

        <div
          className="flex flex-wrap gap-1 px-6 py-3"
          role="tablist"
          aria-label={t.projectDetail.services.addModal.addTitle}
        >
          {(
            [
              {
                id: "catalog",
                label: t.projectDetail.services.addModal.repositorySource.catalog,
                icon: "layers",
              },
              {
                id: "repository",
                label: t.projectDetail.services.addModal.repositorySource.title,
                icon: "github",
              },
              { id: "image", label: t.projectDetail.services.addModal.customImage, icon: "docker" },
              ...(projectId
                ? [
                    {
                      id: "existing" as const,
                      label: t.projects.connections.connectExisting,
                      icon: "plug" as const,
                    },
                  ]
                : []),
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={sourceMode === item.id}
              disabled={saving}
              onClick={() => {
                if (sourceMode === item.id) return;
                setSourceMode(item.id);
                handlePick(CUSTOM_ENTRY, true);
                if (item.id === "catalog" || item.id === "existing") setStep("pick");
              }}
              className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${sourceMode === item.id ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
            >
              <UiIcon name={item.icon} className="size-4" />
              {item.label}
            </button>
          ))}
        </div>

        {sourceMode === "existing" && projectId ? (
          <div className="overflow-y-auto">
            <ProjectConnectionForm targetProjectId={projectId} onClose={onClose} hideHeader />
          </div>
        ) : sourceMode === "repository" && !repository ? (
          <div className="space-y-4 px-6 py-10 text-center">
            <UiIcon name="github" className="mx-auto size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t.projectDetail.services.addModal.repositorySource.noRepository}
            </p>
            {projectId && (
              <Button asChild variant="secondary">
                <Link href={`/projects/${projectId}/source`} onClick={onClose}>
                  {t.projectDetail.services.addModal.repositorySource.connectRepository}
                </Link>
              </Button>
            )}
          </div>
        ) : sourceMode === "catalog" && step === "pick" ? (
          <CatalogPickStep
            catalog={visibleCatalog}
            categories={categories}
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onPick={handlePick}
          />
        ) : (
          <ConfigureStep
            repositoryFields={
              sourceMode === "repository" && repository ? (
                <RepositoryBuildFields
                  source={repository}
                  context={buildContext}
                  dockerfile={dockerfile}
                  onContext={setBuildContext}
                  onDockerfile={setDockerfile}
                />
              ) : undefined
            }
            projectName={projectName}
            selected={selected}
            name={name}
            setName={setName}
            image={image}
            setImage={setImage}
            ports={ports}
            setPorts={setPorts}
            volumeRows={volumeRows}
            setVolumeRows={setVolumeRows}
            envRows={envRows}
            setEnvRows={setEnvRows}
            exposed={exposed}
            setExposed={setExposed}
            exposedPort={exposedPort}
            setExposedPort={setExposedPort}
            domain={domain}
            setDomain={setDomain}
            customDomain={customDomain}
            setCustomDomain={setCustomDomain}
            domainType={domainType}
            setDomainType={setDomainType}
            error={error}
            saving={saving}
            onCancel={onClose}
            onSubmit={handleSubmit}
          />
        )}
      </div>
    </Modal>
  );
}

/* ─── Catalog (Step 1) ─────────────────────────────────────────────────── */

function CatalogPickStep({
  catalog,
  categories,
  activeCategory,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  onPick,
}: {
  catalog: ImageCatalogEntry[];
  categories: Array<{ id: string; label: string; icon: IconName; count: number }>;
  activeCategory: string | null;
  onCategoryChange: (c: string | null) => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onPick: (entry: ImageCatalogEntry) => void;
}) {
  const { t } = useI18n();
  const m = t.projectDetail.services.addModal;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 px-6 pb-4 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <UiIcon
            name="search"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            variant="filled"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={m.searchPlaceholder}
            aria-label={m.searchPlaceholder}
            className="ps-9"
          />
        </div>
        <CustomSelect
          variant="filled"
          value={activeCategory ?? "all"}
          className="sm:w-52"
          aria-label={m.browse}
          onChange={(value) => onCategoryChange(value === "all" ? null : value)}
          options={[
            { value: "all", label: m.allServices },
            ...categories.map((c) => ({ value: c.id, label: c.label })),
          ]}
        />
      </div>
      <div className="min-h-0 max-h-[55vh] overflow-y-auto px-6 pb-6">
        {catalog.length ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.map((entry) => (
              <CatalogCard key={entry.id} entry={entry} onClick={() => onPick(entry)} />
            ))}
          </div>
        ) : (
          <div className="py-12 text-center">
            <UiIcon name="search" className="mx-auto mb-3 size-7 text-muted-foreground" />
            <p className="text-sm font-medium">{m.noMatchesTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{m.repositorySource.noMatches}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function CatalogCard({ entry, onClick }: { entry: ImageCatalogEntry; onClick: () => void }) {
  const { t } = useI18n();
  const m = t.projectDetail.services.addModal;
  const accent = CATEGORY_ACCENTS[bucketEntry(entry)] ?? "bg-muted/30 text-muted-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      title={entry.description ?? undefined}
      className="group flex min-w-0 items-center gap-3 rounded-xl bg-background/60 p-3.5 text-start transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-ring"
    >
      <div
        className={`size-9 rounded-lg flex items-center justify-center shrink-0 overflow-hidden ${accent}`}
      >
        <CatalogIcon entry={entry} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate leading-tight">
          {entry.name ?? entry.image ?? m.unnamed}
        </p>
        {entry.image && (
          <p className="text-xs text-muted-foreground truncate font-mono mt-1">{entry.image}</p>
        )}
      </div>
    </button>
  );
}

/* ─── Configure (Step 2) ───────────────────────────────────────────────── */

function ConfigureStep({
  repositoryFields,
  projectName,
  selected,
  name,
  setName,
  image,
  setImage,
  ports,
  setPorts,
  volumeRows,
  setVolumeRows,
  envRows,
  setEnvRows,
  exposed,
  setExposed,
  exposedPort,
  setExposedPort,
  domain,
  setDomain,
  customDomain,
  setCustomDomain,
  domainType,
  setDomainType,
  error,
  saving,
  onCancel,
  onSubmit,
}: {
  repositoryFields?: React.ReactNode;
  projectName: string;
  selected: ImageCatalogEntry | null;
  name: string;
  setName: (v: string) => void;
  image: string;
  setImage: (v: string) => void;
  ports: string;
  setPorts: (v: string) => void;
  volumeRows: VolumeRow[];
  setVolumeRows: React.Dispatch<React.SetStateAction<VolumeRow[]>>;
  envRows: EnvRow[];
  setEnvRows: (rows: EnvRow[]) => void;
  exposed: boolean;
  setExposed: (v: boolean) => void;
  exposedPort: string;
  setExposedPort: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  customDomain: string;
  setCustomDomain: (v: string) => void;
  domainType: "free" | "custom";
  setDomainType: (v: "free" | "custom") => void;
  error: string | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => Promise<void>;
}) {
  const { t } = useI18n();
  const m = t.projectDetail.services.addModal;
  const portList = useMemo(
    () =>
      ports
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean),
    [ports],
  );

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <fieldset disabled={saving} className="min-w-0 space-y-5 px-6 py-5">
          {selected && !isCustom(selected) && (
            <div className="rounded-2xl border border-border/40 bg-muted/15 px-4 py-3 flex items-center gap-3">
              <div
                className={`size-9 rounded-xl flex items-center justify-center shrink-0 overflow-hidden ${CATEGORY_ACCENTS[bucketEntry(selected)] ?? "bg-card/60 text-muted-foreground"}`}
              >
                <CatalogIcon entry={selected} className="size-6" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{selected.name}</p>
                <p className="text-xs text-muted-foreground/80 truncate">
                  {selected.description ?? selected.image}
                </p>
              </div>
            </div>
          )}

          {repositoryFields}

          {/* Two-col: name + ports together - most services have one short port,
            wasting a full row on it just for "5432" felt off. */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
            <Field label={m.serviceName}>
              <Input
                variant="filled"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={repositoryFields ? "api" : "postgres"}
                spellCheck={false}
                autoComplete="off"
                className="w-full"
              />
            </Field>
            <Field label={m.ports}>
              <Input
                variant="filled"
                type="text"
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                placeholder={repositoryFields ? "3000" : "5432"}
                spellCheck={false}
                autoComplete="off"
                className="w-full font-mono"
              />
            </Field>
          </div>

          {!repositoryFields && (
            <Field label={m.image}>
              <Input
                variant="filled"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="postgres:16-alpine"
                spellCheck={false}
                autoComplete="off"
                className="w-full font-mono"
              />
            </Field>
          )}

          {/* Volumes - structured name/path pairs instead of raw compose syntax */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {m.persistentVolumes}
              </span>
              <span className="text-[11px] text-muted-foreground/60">
                {selected?.defaultVolumes?.length ? m.preSeeded : m.optional}
              </span>
            </div>
            {volumeRows.length > 0 ? (
              <div className="space-y-2">
                {volumeRows.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      variant="filled"
                      type="text"
                      value={row.name}
                      onChange={(e) =>
                        setVolumeRows((rows) =>
                          rows.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)),
                        )
                      }
                      placeholder="volume_name"
                      spellCheck={false}
                      autoComplete="off"
                      className="h-10 w-[180px] shrink-0 rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                    />
                    <span className="text-muted-foreground/50 text-sm shrink-0">→</span>
                    <Input
                      variant="filled"
                      type="text"
                      value={row.path}
                      onChange={(e) =>
                        setVolumeRows((rows) =>
                          rows.map((r, i) => (i === idx ? { ...r, path: e.target.value } : r)),
                        )
                      }
                      placeholder="/path/in/container"
                      spellCheck={false}
                      autoComplete="off"
                      className="h-10 flex-1 min-w-0 rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setVolumeRows((rows) => rows.filter((_, i) => i !== idx))}
                      className="size-10 shrink-0 rounded-xl text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground inline-flex items-center justify-center"
                      aria-label={m.removeVolume}
                    >
                      <UiIcon name="close" className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setVolumeRows((rows) => [...rows, { name: "", path: "" }])}
              className={`inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors ${
                volumeRows.length > 0 ? "mt-2" : ""
              }`}
            >
              <UiIcon name="plus" className="size-3.5" />
              {m.addVolume}
            </button>
            <p className="mt-1.5 text-sm text-muted-foreground">{m.volumesHint}</p>
          </div>

          {/* Env vars - reuses the shared editor in settings mode (no DeploymentContext required). */}
          <div>
            <EnvironmentVariables
              mode="settings"
              envVars={envRows}
              onEnvVarsChange={setEnvRows}
              isEditingMode={true}
              setIsEditingMode={() => {
                /* always editing in this modal */
              }}
              showSettingsActions={false}
              borderless
            />
          </div>

          <div className="rounded-2xl border border-border/50 bg-muted/10 p-4">
            <RoutingSettingsCard
              projectName={projectName}
              domain={domain}
              customDomain={customDomain}
              domainType={domainType}
              exposed={exposed}
              ports={portList}
              exposedPort={exposedPort}
              onExposedChange={setExposed}
              onDomainTypeChange={setDomainType}
              onDomainChange={setDomain}
              onCustomDomainChange={setCustomDomain}
              onExposedPortChange={setExposedPort}
              saveMode="change"
            />
          </div>
        </fieldset>
      </div>

      {error && (
        <div
          role="alert"
          className="mx-6 mb-3 shrink-0 rounded-xl border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger"
        >
          {error}
        </div>
      )}
      {repositoryFields && (
        <p className="shrink-0 px-6 pb-3 text-xs text-muted-foreground">
          {m.repositorySource.deployHint}
        </p>
      )}
      {/* Footer */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/40 px-6 py-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground/[0.06] px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
        >
          <UiIcon name="close" className="size-4" />
          {m.cancel}
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? (
            <UiIcon name="spinner" className="size-4 animate-spin" />
          ) : (
            <UiIcon name="plus" className="size-4" />
          )}
          {m.addService}
        </button>
      </div>
    </form>
  );
}

/* ─── Pieces ───────────────────────────────────────────────────────────── */

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
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
