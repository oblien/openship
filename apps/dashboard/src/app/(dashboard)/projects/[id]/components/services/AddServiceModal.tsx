"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Box,
  Cloud,
  Container,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  Mail,
  MessageSquare,
  Plus,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { imagesApi, type ImageCatalogEntry } from "@/lib/api/images";
import type { ServiceInput } from "@/lib/api/services";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { defaultDomainType } from "@/lib/default-domain-type";
import { getApiErrorMessage } from "@/lib/api";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import { LOCAL_SERVICE_CATALOG } from "./local-service-catalog";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface AddServiceModalProps {
  open: boolean;
  projectName: string;
  // True when the *project itself* deploys to openship cloud, regardless of
  // the dashboard install mode. A self-hosted dashboard can still manage a
  // cloud project — in that case only cloud (Oblien) images are valid and
  // the local upstream-image catalog must be hidden.
  isCloudProject?: boolean;
  onClose: () => void;
  onSubmit: (data: ServiceInput) => Promise<void>;
}

type EnvRow = { key: string; value: string; visible: boolean };

// Sentinel entry rendered at the end of the catalog grid so the user can
// pick a plain Docker image string instead of a curated catalog entry.
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
    value: e.value ?? "",
    visible: true,
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
  return entry.defaultVolumes
    .map(parseVolumeString)
    .filter((r): r is VolumeRow => r !== null);
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
  icon: React.ElementType;
  /** Substrings (lowercased) - match against category, tags, name, image. */
  match: string[];
}

const CATEGORIES: CategoryDef[] = [
  {
    id: "database",
    label: "Databases",
    icon: Database,
    match: ["database", "db", "sql", "postgres", "mysql", "mariadb", "mongo", "cockroach", "neon", "sqlite"],
  },
  {
    id: "cache",
    label: "Caches",
    icon: Zap,
    match: ["cache", "redis", "memcached", "dragonfly", "keydb"],
  },
  {
    id: "search",
    label: "Search",
    icon: Search,
    match: ["search", "elastic", "opensearch", "meilisearch", "typesense", "solr"],
  },
  {
    id: "vector",
    label: "Vector & AI",
    icon: Sparkles,
    match: ["vector", "qdrant", "weaviate", "milvus", "chroma", "pgvector", "embedding", "llm", "ollama"],
  },
  {
    id: "queue",
    label: "Queues & Streams",
    icon: MessageSquare,
    match: ["queue", "broker", "rabbitmq", "kafka", "nats", "pulsar", "redpanda", "mqtt"],
  },
  {
    id: "storage",
    label: "Object Storage",
    icon: HardDrive,
    match: ["storage", "minio", "s3", "garage", "seaweedfs", "ceph"],
  },
  {
    id: "auth",
    label: "Auth & Identity",
    icon: ShieldCheck,
    match: ["auth", "identity", "keycloak", "authentik", "oauth", "oidc"],
  },
  {
    id: "mail",
    label: "Mail & SMTP",
    icon: Mail,
    match: ["mail", "smtp", "mailpit", "mailhog", "smtp4dev", "postal"],
  },
  {
    id: "runtime",
    label: "Runtimes",
    icon: Rocket,
    match: ["runtime", "node", "python", "deno", "bun", "go", "ruby", "php"],
  },
];

const OTHER_CATEGORY_ID = "other";
const CUSTOM_CATEGORY_ID = "__custom__";

/**
 * Bucket a catalog entry into one of the curated categories. Walks
 * (category → tags → name → image) and returns the first match. Falls
 * through to "other" so nothing is hidden.
 */
function bucketEntry(entry: ImageCatalogEntry): string {
  const haystack = [
    entry.category,
    ...(entry.tags ?? []),
    entry.id,
    entry.name,
    entry.image,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.match.some((kw) => haystack.includes(kw))) return cat.id;
  }
  return OTHER_CATEGORY_ID;
}

export function AddServiceModal({ open, projectName, isCloudProject, onClose, onSubmit }: AddServiceModalProps) {
  const { t } = useI18n();
  const { deployMode } = usePlatform();
  const cloud = useCloud();
  const newEndpointDomainType = defaultDomainType(cloud.connected);
  // Cloud-only catalog when EITHER the install is the SaaS dashboard
  // (deployMode === "cloud") OR this specific project is deployed to
  // openship cloud (isCloudProject). In either case the local upstream-
  // image catalog isn't applicable and we pin the source to "cloud".
  const cloudOnly = deployMode === "cloud" || !!isCloudProject;

  // Step state - "pick" shows the catalog, "configure" shows the form.
  const [step, setStep] = useState<"pick" | "configure">("pick");
  const [selected, setSelected] = useState<ImageCatalogEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Active category in the left rail. null = "All". Special sentinel
  // "__custom__" filters down to just the custom-image tile.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // Catalog state
  const [catalog, setCatalog] = useState<ImageCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [cloudConnected, setCloudConnected] = useState<boolean | null>(null);
  // Catalog source: "local" = curated upstream Docker images, "cloud" = Oblien
  // managed images. Cloud-only contexts (SaaS install OR cloud-deployed
  // project) are pinned to "cloud" — it's the only valid source. Local
  // projects on local installs default to "local" but can flip via the
  // switcher when the user wants a managed image.
  const [catalogSource, setCatalogSource] = useState<"local" | "cloud">(
    cloudOnly ? "cloud" : "local",
  );

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
  const [error, setError] = useState<string | null>(null);

  // Reset everything when the modal opens - never carry state between sessions
  useEffect(() => {
    if (!open) return;
    setStep("pick");
    setSelected(null);
    setSearchQuery("");
    setActiveCategory(null);
    setCatalogSource(cloudOnly ? "cloud" : "local");
    setName("");
    setImage("");
    setPorts("");
    setVolumeRows([]);
    setEnvRows([]);
    setExposed(false);
    setExposedPort("");
    setDomain("");
    setCustomDomain("");
    setDomainType("free");
    setSaving(false);
    setError(null);
  }, [open]);

  // Load the catalog when the modal opens, or when the user flips the source
  // switcher in local deployments. Sources:
  //  - "local" → bundled `LOCAL_SERVICE_CATALOG` (clean upstream Docker
  //              images like postgres, redis, qdrant - what people run on
  //              their own machine or server)
  //  - "cloud" → Oblien `images.list()` (oblien/* managed cloud images)
  // Either way "no catalog" never blocks the user - Custom image is always
  // an escape hatch.
  useEffect(() => {
    if (!open) return;

    // Reset filters when the source changes so we don't keep a category
    // active that doesn't exist in the new catalog.
    setActiveCategory(null);

    if (catalogSource === "local") {
      setCatalog(LOCAL_SERVICE_CATALOG);
      setCloudConnected(null);
      setCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setCatalogLoading(true);
    imagesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.images ?? []);
        setCloudConnected(res.cloudConnected ?? true);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog([]);
        setCloudConnected(false);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
    // Re-fetch when the cloud connection flips (e.g. the user connects from the
    // empty-state CTA) so the catalog + connected flag refresh without reopening.
  }, [open, catalogSource, cloud.connected]);

  // Bucket every catalog entry once into a curated category. We memoize
  // the assignments so search/filter doesn't re-run bucketEntry per render.
  const bucketed = useMemo(() => {
    return catalog.map((entry) => ({ entry, bucket: bucketEntry(entry) }));
  }, [catalog]);

  // Counts per curated category - only includes buckets that actually have
  // entries, in the curated order (so the rail stays predictable). "Other"
  // is appended at the end if it has anything.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { bucket } of bucketed) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const catLabels = t.projectDetail.services.addModal.categories as Record<string, string>;
    const ordered: Array<{ id: string; label: string; icon: React.ElementType; count: number }> = [];
    for (const cat of CATEGORIES) {
      const count = counts.get(cat.id) ?? 0;
      if (count > 0) ordered.push({ id: cat.id, label: catLabels[cat.id] ?? cat.label, icon: cat.icon, count });
    }
    const otherCount = counts.get(OTHER_CATEGORY_ID) ?? 0;
    if (otherCount > 0) {
      ordered.push({ id: OTHER_CATEGORY_ID, label: catLabels.other, icon: Box, count: otherCount });
    }
    return ordered;
  }, [bucketed, t]);

  // Filter the catalog by active category and search query.
  const visibleCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return bucketed
      .filter(({ entry, bucket }) => {
        if (activeCategory && activeCategory !== CUSTOM_CATEGORY_ID) {
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

  // The custom-image tile shows in "All" and in the dedicated "Custom" category.
  const showCustomTile = activeCategory === null || activeCategory === CUSTOM_CATEGORY_ID;

  const handlePick = (entry: ImageCatalogEntry) => {
    setSelected(entry);
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

    const trimmedName = name.trim();
    const trimmedImage = image.trim();

    if (!trimmedName) {
      setError(t.projectDetail.services.addModal.serviceNameRequired);
      return;
    }
    if (!trimmedImage) {
      setError(t.projectDetail.services.addModal.imageRequired);
      return;
    }

    setSaving(true);
    setError(null);

    const portList = ports
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    const volumeList = volumeStringsFromRows(volumeRows);

    const payload: ServiceInput = {
      name: trimmedName,
      image: trimmedImage,
      build: "",
      dockerfile: "",
      ports: portList,
      dependsOn: [],
      environment: envObjectFromRows(envRows),
      volumes: volumeList,
      command: "",
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
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, t.projectDetail.services.addModal.addServiceFailed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      showCloseButton={false}
      maxWidth={step === "pick" ? "1080px" : "760px"}
      width="100%"
      maxHeight="92vh"
    >
      <div className="flex max-h-[92vh] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-5">
          <div className="flex items-center gap-3 min-w-0">
            {step === "configure" && (
              <button
                type="button"
                onClick={handleBackToCatalog}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={t.projectDetail.services.addModal.backToCatalog}
              >
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground truncate">
                {step === "pick"
                  ? t.projectDetail.services.addModal.addTitle
                  : interpolate(t.projectDetail.services.addModal.configureTitle, { name: selected?.name ?? t.projectDetail.services.addModal.fallbackService })}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground truncate">
                {step === "pick"
                  ? t.projectDetail.services.addModal.pickSubtitle
                  : t.projectDetail.services.addModal.configureSubtitle}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {/* Source switcher lives in the header so it sits visually with
                the deploy-mode context, not buried in the right pane. Only
                shown on the picker step (configure is already scoped to a
                single selected service) and only when the user has a real
                choice - cloud-only contexts (SaaS install OR cloud-deployed
                project) are pinned to the cloud catalog. */}
            {step === "pick" && !cloudOnly ? (
              <SourceSwitcher value={catalogSource} onChange={setCatalogSource} />
            ) : (
              <ModeBadge mode={cloudOnly ? "cloud" : "local"} />
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label={t.projectDetail.services.addModal.close}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {step === "pick" ? (
          <CatalogPickStep
            catalog={visibleCatalog}
            categories={categories}
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
            totalCount={catalog.length}
            loading={catalogLoading}
            source={catalogSource}
            cloudConnected={cloudConnected}
            onConnectCloud={() => void cloud.requireCloud("cloud-services-catalog")}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            showCustomTile={showCustomTile}
            onPick={handlePick}
          />
        ) : (
          <ConfigureStep
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
  totalCount,
  loading,
  source,
  cloudConnected,
  onConnectCloud,
  searchQuery,
  onSearchChange,
  showCustomTile,
  onPick,
}: {
  catalog: ImageCatalogEntry[];
  categories: Array<{ id: string; label: string; icon: React.ElementType; count: number }>;
  activeCategory: string | null;
  onCategoryChange: (c: string | null) => void;
  totalCount: number;
  loading: boolean;
  source: "local" | "cloud";
  cloudConnected: boolean | null;
  onConnectCloud: () => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  showCustomTile: boolean;
  onPick: (entry: ImageCatalogEntry) => void;
}) {
  const { t } = useI18n();
  const m = t.projectDetail.services.addModal;
  const hasNoResults = !loading && catalog.length === 0 && !showCustomTile;

  // Cloud catalog picked but the instance isn't linked to Openship Cloud yet —
  // there's nothing to browse, so lead with a connect CTA instead of an empty
  // pane. Connecting flips `cloud.connected`, which re-fetches the catalog.
  if (source === "cloud" && cloudConnected === false && !loading) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10">
            <Cloud className="size-7 text-primary" />
          </div>
          <h3 className="text-[15px] font-semibold text-foreground">{m.cloudConnectTitle}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{m.cloudConnectBody}</p>
          <button
            type="button"
            onClick={onConnectCloud}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Cloud className="size-4" />
            {m.cloudConnectButton}
          </button>
        </div>
      </div>
    );
  }
  const activeLabel =
    activeCategory === null
      ? m.allServices
      : activeCategory === CUSTOM_CATEGORY_ID
        ? m.customImage
        : categories.find((c) => c.id === activeCategory)?.label ?? m.services;

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── Left rail: curated categories ───────────────────────────── */}
      <aside className="hidden md:flex md:flex-col w-[240px] shrink-0 border-e border-border/40 bg-muted/[0.04]">
        <div className="px-5 pt-5 pb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
          {m.browse}
        </div>
        <div className="flex-1 overflow-y-auto px-2.5 pb-3 space-y-0.5">
          <CategoryItem
            icon={Sparkles}
            label={m.allServices}
            count={totalCount}
            active={activeCategory === null}
            onClick={() => onCategoryChange(null)}
          />
          {categories.map((c) => (
            <CategoryItem
              key={c.id}
              icon={c.icon}
              label={c.label}
              count={c.count}
              active={activeCategory === c.id}
              onClick={() => onCategoryChange(c.id)}
            />
          ))}
        </div>
        <div className="border-t border-border/30 px-2.5 py-3">
          <CategoryItem
            icon={Plus}
            label={m.customImage}
            active={activeCategory === CUSTOM_CATEGORY_ID}
            onClick={() => onCategoryChange(CUSTOM_CATEGORY_ID)}
          />
        </div>
      </aside>

      {/* ── Right pane: search + grid ───────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-7 pt-5 pb-4 border-b border-border/30 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-[15px] font-semibold text-foreground truncate">{activeLabel}</h3>
            {!loading && catalog.length > 0 && (
              <span className="text-[11px] font-medium text-muted-foreground/70 tabular-nums shrink-0">
                {interpolate(catalog.length === 1 ? m.serviceCountOne : m.serviceCountOther, { count: String(catalog.length) })}
              </span>
            )}
          </div>
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={m.searchPlaceholder}
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full rounded-xl border border-border/50 bg-muted/20 ps-9 pe-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </div>
          {cloudConnected === false && (
            <p className="text-[12px] text-muted-foreground">
              {m.cloudConnectHint}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-7 py-5">
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border/40 bg-muted/10 p-3 h-[64px] animate-pulse"
                />
              ))}
            </div>
          ) : hasNoResults ? (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <div className="size-11 rounded-xl bg-muted/40 flex items-center justify-center mb-3">
                <Search className="size-4 text-muted-foreground/60" />
              </div>
              <p className="text-sm font-medium text-foreground">{m.noMatchesTitle}</p>
              <p className="text-xs text-muted-foreground/70 mt-1 max-w-[280px]">
                {m.noMatchesBody}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {catalog.map((entry, idx) => (
                <CatalogCard
                  key={entry.id ?? entry.name ?? idx}
                  entry={entry}
                  onClick={() => onPick(entry)}
                />
              ))}
              {showCustomTile && (
                <CatalogCard
                  entry={CUSTOM_ENTRY}
                  onClick={() => onPick(CUSTOM_ENTRY)}
                  highlight
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceSwitcher({
  value,
  onChange,
}: {
  value: "local" | "cloud";
  onChange: (v: "local" | "cloud") => void;
}) {
  const { t } = useI18n();
  const options: Array<{ value: "local" | "cloud"; label: string; icon: React.ElementType }> = [
    { value: "local", label: t.projectDetail.services.addModal.localImages, icon: Cpu },
    { value: "cloud", label: t.projectDetail.services.addModal.openshipCloud, icon: Cloud },
  ];
  return (
    <div className="inline-flex w-fit items-center gap-0.5 rounded-xl border border-border/60 bg-muted/60 p-0.5">
      {options.map((opt) => {
        const active = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-all ${
              active
                ? "bg-card text-foreground shadow-sm ring-1 ring-border/70"
                : "text-muted-foreground/80 hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function CategoryItem({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full group flex items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-all ${
        active
          ? "bg-foreground/[0.06] text-foreground"
          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
      }`}
    >
      <span
        className={`flex size-7 items-center justify-center rounded-lg shrink-0 transition-colors ${
          active ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground/70 group-hover:text-foreground"
        }`}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{label}</span>
      {typeof count === "number" && (
        <span
          className={`text-[11px] font-semibold tabular-nums shrink-0 ${
            active ? "text-foreground/70" : "text-muted-foreground/50"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function CatalogCard({
  entry,
  onClick,
  highlight,
}: {
  entry: ImageCatalogEntry;
  onClick: () => void;
  highlight?: boolean;
}) {
  const { t } = useI18n();
  const m = t.projectDetail.services.addModal;
  const custom = isCustom(entry);
  return (
    <button
      type="button"
      onClick={onClick}
      title={custom ? m.customEntryDescription : (entry.description ?? undefined)}
      className={`group relative flex items-center gap-3 text-start rounded-xl border p-3 transition-all ${
        highlight
          ? "border-dashed border-border/60 bg-muted/[0.04] hover:border-primary/50 hover:bg-primary/[0.03]"
          : "border-border/40 bg-card hover:border-primary/40 hover:bg-foreground/[0.015]"
      }`}
    >
      <div className="size-9 rounded-lg bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-border/30 group-hover:ring-border/50 transition-all">
        {custom ? (
          <Plus className="size-4 text-muted-foreground/80" />
        ) : entry.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.logo}
            alt={entry.name ?? entry.image ?? "service"}
            className="size-5 object-contain"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : (
          <Container className="size-4 text-muted-foreground/80" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground truncate leading-tight">
          {custom ? m.customImage : (entry.name ?? entry.image ?? m.unnamed)}
        </p>
        {!custom && entry.image && (
          <p className="text-[11px] text-muted-foreground/60 truncate font-mono mt-0.5">
            {entry.image}
          </p>
        )}
      </div>
    </button>
  );
}

/* ─── Configure (Step 2) ───────────────────────────────────────────────── */

function ConfigureStep({
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
    <form onSubmit={onSubmit} className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {error && (
          <div className="rounded-xl border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {selected && !isCustom(selected) && (
          <div className="rounded-2xl border border-border/40 bg-muted/15 px-4 py-3 flex items-center gap-3">
            <div className="size-9 rounded-xl bg-card/60 flex items-center justify-center shrink-0 overflow-hidden">
              {selected.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.logo}
                  alt={selected.name ?? ""}
                  className="size-6 object-contain"
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                />
              ) : (
                <Container className="size-4 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{selected.name}</p>
              <p className="text-xs text-muted-foreground/80 truncate">{selected.description ?? selected.image}</p>
            </div>
          </div>
        )}

        {/* Two-col: name + ports together - most services have one short port,
            wasting a full row on it just for "5432" felt off. */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
          <Field label={m.serviceName}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="postgres"
              spellCheck={false}
              autoComplete="off"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.ports}>
            <input
              type="text"
              value={ports}
              onChange={(e) => setPorts(e.target.value)}
              placeholder="5432"
              spellCheck={false}
              autoComplete="off"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
            />
          </Field>
        </div>

        <Field label={m.image}>
          <input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="postgres:16-alpine"
            spellCheck={false}
            autoComplete="off"
            className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
          />
        </Field>

        {/* Volumes - structured name/path pairs instead of raw compose syntax */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-xs font-medium text-muted-foreground">{m.persistentVolumes}</span>
            <span className="text-[11px] text-muted-foreground/60">
              {selected?.defaultVolumes?.length
                ? m.preSeeded
                : m.optional}
            </span>
          </div>
          {volumeRows.length > 0 ? (
            <div className="space-y-2">
              {volumeRows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) =>
                      setVolumeRows((rows) => rows.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)))
                    }
                    placeholder="volume_name"
                    spellCheck={false}
                    autoComplete="off"
                    className="h-10 w-[180px] shrink-0 rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                  />
                  <span className="text-muted-foreground/50 text-sm shrink-0">→</span>
                  <input
                    type="text"
                    value={row.path}
                    onChange={(e) =>
                      setVolumeRows((rows) => rows.map((r, i) => (i === idx ? { ...r, path: e.target.value } : r)))
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
                    <X className="size-4" />
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
            <Plus className="size-3.5" />
            {m.addVolume}
          </button>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {m.volumesHint}
          </p>
        </div>

        {/* Env vars - reuses the shared editor in settings mode (no DeploymentContext required). */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">{m.environmentVariables}</p>
          <EnvironmentVariables
            mode="settings"
            envVars={envRows}
            onEnvVarsChange={setEnvRows}
            isEditingMode={true}
            setIsEditingMode={() => { /* always editing in this modal */ }}
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
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-border/40 px-6 py-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground/[0.06] px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
        >
          <X className="size-4" />
          {m.cancel}
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
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

function ModeBadge({ mode }: { mode: "cloud" | "local" }) {
  const { t } = useI18n();
  const Icon = mode === "cloud" ? Cloud : Cpu;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <Icon className="size-3" />
      {mode === "cloud" ? t.projectDetail.services.addModal.openshipCloud : t.projectDetail.services.addModal.localDocker}
    </span>
  );
}

