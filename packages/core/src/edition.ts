/**
 * Product edition. OpenShip Operator is the only product.
 *
 * CLOUD_MODE=true is a boot-time hard fail in the API. These helpers still
 * accept the flag so callers and tests can detect the rejected value.
 */

export type Edition = "operator";

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

export function parseCloudModeFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/** Operator is the only edition. A true cloudMode flag is rejected at API boot. */
export function resolveEdition(_opts?: { cloudMode?: boolean }): Edition {
  return "operator";
}

export function featuresForEdition(_edition?: Edition): EditionFeatures {
  return OPERATOR_FEATURES;
}

export function resolveEditionState(_opts?: { cloudMode?: boolean }): {
  edition: Edition;
  features: EditionFeatures;
} {
  return { edition: "operator", features: OPERATOR_FEATURES };
}
