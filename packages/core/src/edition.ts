/**
 * Product edition: Operator (local-first control plane) vs Cloud (SaaS).
 *
 * Mapped from CLOUD_MODE only — operator := !CLOUD_MODE, cloud := CLOUD_MODE.
 * Do not add a parallel OPENSHIP_EDITION flag that can disagree with CLOUD_MODE.
 */

export type Edition = "operator" | "cloud";

export type EditionFeatures = {
  billing: boolean;
  cloudConnect: boolean;
  publicSignup: boolean;
  hostedGithubApp: boolean;
  cloudDeploy: boolean;
};

export const OPERATOR_FEATURES: EditionFeatures = {
  billing: false,
  cloudConnect: false,
  publicSignup: false,
  hostedGithubApp: false,
  cloudDeploy: false,
};

export const CLOUD_FEATURES: EditionFeatures = {
  billing: true,
  cloudConnect: true,
  publicSignup: true,
  hostedGithubApp: true,
  cloudDeploy: true,
};

export function parseCloudModeFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/** CLOUD_MODE on → cloud; everything else is operator (docker | bare | desktop). */
export function resolveEdition(opts: { cloudMode: boolean }): Edition {
  return opts.cloudMode ? "cloud" : "operator";
}

export function featuresForEdition(edition: Edition): EditionFeatures {
  return edition === "cloud" ? CLOUD_FEATURES : OPERATOR_FEATURES;
}

export function resolveEditionState(opts: { cloudMode: boolean }): {
  edition: Edition;
  features: EditionFeatures;
} {
  const edition = resolveEdition(opts);
  return { edition, features: featuresForEdition(edition) };
}
