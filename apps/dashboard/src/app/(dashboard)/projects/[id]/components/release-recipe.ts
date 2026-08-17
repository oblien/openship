import {
  applyReleasePreset,
  isReleasePresetId,
  RELEASE_PRESETS,
  RELEASE_RECIPE_VERSION,
  type ReleaseBuildMode,
  type ReleasePresetId,
  type RuntimeInstall,
} from "@repo/core";

export type MountedReleaseConfigUI = {
  enabled: boolean;
  buildMode?: ReleaseBuildMode;
  runtimeInstall?: RuntimeInstall;
  preset?: string;
  serviceId?: string;
  serviceName?: string;
  sourcePath?: string;
  containerPath: string;
  sharedPaths?: string[];
  prepareCommand?: string;
  builderImage?: string;
  builderMemoryMb?: number;
  builderCpus?: number;
  builderCachePaths?: string[];
  reloadCommand?: string;
  healthPath?: string;
  healthPort?: number;
  retain?: number;
  uid?: number;
  gid?: number;
};

export const emptyReleaseConfig: MountedReleaseConfigUI = {
  enabled: true,
  buildMode: "prebuilt",
  runtimeInstall: "image",
  sourcePath: "",
  containerPath: "/srv/openship-app",
  sharedPaths: [],
  healthPath: "/",
  retain: 5,
};

export const WIZARD_STEPS = [
  { id: "runs", title: "What runs?", blurb: "Environment and the compose service that receives code." },
  { id: "runtime", title: "How is the runtime installed?", blurb: "Existing image, Dockerfile, or Compose." },
  { id: "code", title: "How should normal code ship?", blurb: "Prebuilt in Git, upload, or prepare on the server." },
  { id: "persists", title: "What persists?", blurb: "Database, storage, and uploads stay across releases." },
  { id: "activate", title: "How is it activated?", blurb: "Reload or restart, then a health check." },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

export const PERSIST_OPTIONS = [
  { id: "database" as const, label: "Database", hint: "SQLite file or database directory", path: "database" },
  { id: "storage" as const, label: "Storage", hint: "Framework storage that must survive a swap", path: "storage" },
  { id: "uploads" as const, label: "Uploads", hint: "User-uploaded files", path: "uploads" },
];

export const BUILD_MODE_OPTIONS: Array<{
  value: ReleaseBuildMode;
  title: string;
  copy: string;
}> = [
  {
    value: "prebuilt",
    title: "Prebuilt in Git",
    copy: "Deploy exactly what was committed. No install or build runs on the server.",
  },
  {
    value: "upload",
    title: "Build locally and upload",
    copy: "Pack the artifact on your machine and ship it. Server unpacks and switches.",
  },
  {
    value: "server",
    title: "Prepare on server",
    copy: "Run a release command in the app or a disposable builder before activation.",
  },
];

export const RUNTIME_INSTALL_OPTIONS: Array<{
  value: RuntimeInstall;
  title: string;
  copy: string;
}> = [
  { value: "image", title: "Existing image", copy: "Use the image already on the server. Rebuild only when you ask." },
  { value: "dockerfile", title: "Dockerfile", copy: "Build a runtime image from the repo Dockerfile when it changes." },
  { value: "compose", title: "Compose", copy: "Target a stable service id. Compose or Dockerfile changes rebuild runtime." },
];

export function inferRuntimeInstall(opts: {
  framework?: string | null;
  composePath?: string | null;
  serviceCount: number;
}): RuntimeInstall {
  const framework = opts.framework?.trim().toLowerCase() ?? "";
  if (framework === "docker-compose" || opts.composePath?.trim() || opts.serviceCount > 0) {
    return "compose";
  }
  if (framework === "docker") return "dockerfile";
  return "image";
}

export function applyPresetToDraft(
  draft: MountedReleaseConfigUI,
  id: ReleasePresetId,
): MountedReleaseConfigUI {
  const filled = applyReleasePreset(id);
  return {
    ...draft,
    ...filled,
    serviceId: draft.serviceId,
    serviceName: draft.serviceName,
    uid: draft.uid,
    gid: draft.gid,
    retain: draft.retain ?? 5,
  };
}

export function payloadFromDraft(draft: MountedReleaseConfigUI): MountedReleaseConfigUI {
  const buildMode =
    draft.buildMode ?? (draft.prepareCommand?.trim() ? "server" : "prebuilt");
  return {
    ...draft,
    buildMode,
    preset: isReleasePresetId(draft.preset) ? draft.preset : undefined,
    runtimeInstall: draft.runtimeInstall,
    sourcePath: draft.sourcePath?.trim() || undefined,
    sharedPaths: draft.sharedPaths?.filter(Boolean) ?? [],
    prepareCommand: draft.prepareCommand?.trim() || undefined,
    builderImage: draft.builderImage?.trim() || undefined,
    builderCachePaths: draft.builderCachePaths?.filter(Boolean) ?? [],
    reloadCommand: draft.reloadCommand?.trim() || undefined,
    healthPath: draft.healthPath?.trim() || undefined,
    uid: draft.uid,
    gid: draft.gid,
  };
}

export function recipeSummaryLines(config: MountedReleaseConfigUI | null | undefined): {
  version: number;
  presetLabel: string | null;
  lines: string[];
} {
  if (!config) {
    return { version: RELEASE_RECIPE_VERSION, presetLabel: null, lines: [] };
  }
  const preset = isReleasePresetId(config.preset) ? RELEASE_PRESETS[config.preset] : null;
  const build =
    BUILD_MODE_OPTIONS.find((option) => option.value === (config.buildMode ?? "prebuilt"))?.title ??
    "Prebuilt in Git";
  const runtime =
    RUNTIME_INSTALL_OPTIONS.find((option) => option.value === (config.runtimeInstall ?? "image"))
      ?.title ?? "Existing image";
  const persist = (config.sharedPaths ?? []).filter(Boolean);
  const activate = config.reloadCommand?.trim()
    ? `Reload · ${config.healthPath || "/"}`
    : `Restart · ${config.healthPath || "/"}`;
  return {
    version: RELEASE_RECIPE_VERSION,
    presetLabel: preset?.label ?? null,
    lines: [
      `${runtime} · ${build}`,
      persist.length ? `Persists ${persist.join(", ")}` : "Nothing extra persists",
      activate,
    ],
  };
}
