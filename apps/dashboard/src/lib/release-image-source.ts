import {
  isServicesFramework,
  renderReleaseImage,
  validateReleaseRepository,
  validateReleaseVersionUrl,
  type ReleaseSource,
} from "@repo/core";

type ReleaseImageSourceBase = {
  artifactKind: "image";
  imageTemplate: string;
  /** Reserved source options are not edited here, but a read/edit/save round
   * trip must not erase values configured through the API or an imported dump. */
  channel?: string;
  trackReleases?: boolean;
};

export type ReleaseImageSource = ReleaseImageSourceBase &
  (
    | {
        mode: "github";
        repo: string;
        pinnedVersion?: string;
      }
    | {
        mode: "url";
        versionUrl: string;
        pinnedVersion?: string;
      }
    | {
        mode: "url";
        versionUrl?: string;
        pinnedVersion: string;
      }
  );

export interface ReleaseImageSourceDraft {
  mode: "github" | "url";
  imageTemplate: string;
  repo: string;
  versionUrl: string;
  pinnedVersion: string;
  channel?: string;
  trackReleases?: boolean;
}

export function usesReleaseImageSourceSettings(project: {
  isApp?: boolean | null;
  releaseSource?: ReleaseSource | null;
}): boolean {
  return !project.isApp && project.releaseSource?.artifactKind === "image";
}

/** The project-level endpoint supports one runnable app, never compose or static sites. */
export function canConfigureReleaseImageSource(project: {
  framework?: string | null;
  options?: { workloadType?: string; hasServer?: boolean } | null;
}): boolean {
  const workload = project.options?.workloadType;
  const isStatic = workload === "static" || (!workload && project.options?.hasServer === false);
  return !isServicesFramework(project.framework) && !isStatic;
}

export function releaseImageVersionLabels(input: {
  currentVersion?: string | null;
  latestVersion?: string | null;
  pinnedVersion?: string | null;
  loading: boolean;
  labels?: {
    notDeployed: string;
    checking: string;
    unavailable: string;
  };
}): { current: string; latest: string } {
  const labels = input.labels ?? {
    notDeployed: "Not deployed",
    checking: "Checking…",
    unavailable: "Unavailable",
  };

  return {
    // A pin is a future deploy target, never evidence that anything is live.
    current: input.currentVersion || labels.notDeployed,
    latest:
      input.pinnedVersion ||
      (input.loading ? labels.checking : input.latestVersion || labels.unavailable),
  };
}

/**
 * Turn the source editor's loose strings into the complete PUT payload.
 * Irrelevant fields are deliberately dropped when the mode changes, so an old
 * GitHub repo can never leak into a URL source (or vice versa).
 */
export function releaseImageSourceFromDraft(draft: ReleaseImageSourceDraft): ReleaseImageSource {
  const imageTemplate = draft.imageTemplate.trim();
  const pinnedVersion = draft.pinnedVersion.trim();
  const preserved = {
    ...(draft.channel?.trim() ? { channel: draft.channel.trim() } : {}),
    ...(draft.trackReleases !== undefined ? { trackReleases: draft.trackReleases } : {}),
  };

  // Use the same browser-safe validator as the API/runtime. A representative
  // release catches malformed references and unsafe placeholder placement
  // before the user saves the source; a configured pin validates the exact ref.
  const validationTag = pinnedVersion || "v1.2.3";
  renderReleaseImage(imageTemplate, {
    version: validationTag.replace(/^v/i, ""),
    tag: validationTag,
  });

  if (draft.mode === "github") {
    const repo = draft.repo.trim();
    const invalidRepo = validateReleaseRepository(repo);
    if (invalidRepo) throw new Error(invalidRepo);
    return {
      artifactKind: "image",
      mode: "github",
      imageTemplate,
      repo,
      ...(pinnedVersion ? { pinnedVersion } : {}),
      ...preserved,
    };
  }

  const versionUrl = draft.versionUrl.trim();
  if (!versionUrl && !pinnedVersion) {
    throw new Error("Enter a version URL or pin a version.");
  }
  if (versionUrl) {
    const invalidUrl = validateReleaseVersionUrl(versionUrl);
    if (invalidUrl) throw new Error(invalidUrl);
  }

  if (versionUrl) {
    return {
      artifactKind: "image",
      mode: "url",
      imageTemplate,
      versionUrl,
      ...(pinnedVersion ? { pinnedVersion } : {}),
      ...preserved,
    };
  }
  return {
    artifactKind: "image",
    mode: "url",
    imageTemplate,
    pinnedVersion,
    ...preserved,
  };
}

export function releaseImageDraftFromSource(
  source: ReleaseSource | null | undefined,
): ReleaseImageSourceDraft {
  return {
    mode: source?.mode === "url" ? "url" : "github",
    imageTemplate: source?.imageTemplate ?? "",
    repo: source?.repo ?? "",
    versionUrl: source?.versionUrl ?? "",
    pinnedVersion: source?.pinnedVersion ?? "",
    channel: source?.channel,
    trackReleases: source?.trackReleases,
  };
}
