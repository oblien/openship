/**
 * `openship.json` as a metadata parser — projects the native config's
 * build-shaping subset (framework, install/build/start commands, outputDirectory,
 * routing) into the shared {@link DeploymentMetadata} so it folds over heuristic
 * detection through the same engine as vercel.json, for the repo root AND each
 * monorepo sub-app. It's the NATIVE format and an explicit user declaration, so
 * it's AUTHORITATIVE (registered first, not `fillOnly`, not `nonLocal`).
 *
 * Project-wide + deploy fields the DeploymentMetadata shape doesn't carry
 * (runtime, port, productionMode, resources, domains, services, monorepo, env)
 * are applied separately by the deploy prepare overlay — see the API's
 * prepare.service. Env is handled there too (to preserve `secret` flags), not here.
 */

import { parseOpenshipConfigJson } from "../openship-config/parse";
import type { DeploymentMetadata, MetadataParser } from "./types";

export const openshipMetadataParser: MetadataParser = {
  source: "openship",
  files: ["openship.json"],
  parse(fileContents) {
    const raw = fileContents["openship.json"];
    if (!raw) return null;

    // Diagnostics are deliberately dropped HERE, not everywhere: the API's prepare
    // pipeline parses the ROOT file once and reports its refusals on ProjectInfo
    // (#641). Reporting again from this parser would double every message for the
    // root and needs a widened MetadataParser to say anything about a sub-app —
    // which is the one real gap left, tracked separately.
    const { config } = parseOpenshipConfigJson(raw);
    if (!config) return null;

    const metadata: DeploymentMetadata = { source: "openship" };
    if (config.installCommand) metadata.installCommand = config.installCommand;
    if (config.buildCommand) metadata.buildCommand = config.buildCommand;
    if (config.outputDirectory) metadata.outputDirectory = config.outputDirectory;
    if (config.startCommand) metadata.startCommand = config.startCommand;
    if (config.framework) metadata.framework = config.framework;
    if (config.routes) metadata.routing = config.routes;

    const hasSignal =
      config.installCommand ||
      config.buildCommand ||
      config.outputDirectory ||
      config.startCommand ||
      config.framework ||
      config.routes;
    return hasSignal ? metadata : null;
  },
};
