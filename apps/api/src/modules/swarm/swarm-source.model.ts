/** Pure validation and redaction rules for authoritative Swarm stack sources. */

import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { AppError, type SwarmSourceKind } from "@repo/core";
import type { SwarmStack } from "@repo/db";

export const MAX_SWARM_STACK_NAME_LENGTH = 63;
export const MAX_INLINE_STACK_SOURCE_BYTES = 1_000_000;
const STACK_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

export type StackSourceInput =
  | {
      kind: "inline";
      yaml: string;
      expectedVersion: number;
    }
  | {
      kind: "repository";
      composePaths: string[];
      sourcePath?: string;
      branch?: string;
      commitSha?: string;
      expectedVersion: number;
    }
  | {
      kind: "adopted";
      expectedVersion: number;
    };

export interface ValidatedStackSource {
  kind: SwarmSourceKind;
  sourcePaths: string[];
  sourcePath: string | null;
  sourceBranch: string | null;
  sourceCommitSha: string | null;
  /** Never expose or log this value; callers encrypt it before persistence. */
  inlineYaml: string | null;
  sourceDigest: string | null;
  expectedVersion: number;
}

export function assertSwarmStackName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    normalized.length > MAX_SWARM_STACK_NAME_LENGTH ||
    !STACK_NAME.test(normalized)
  ) {
    throw new AppError(
      `Stack name must be ${MAX_SWARM_STACK_NAME_LENGTH} characters or fewer and contain only lowercase letters, numbers, dots, underscores, and hyphens.`,
      400,
      "SWARM_STACK_NAME_INVALID",
    );
  }
  return normalized;
}

/** Paths are source references only; filesystem confinement happens before every read in S3.3. */
export function assertRelativeSourcePath(value: string, field: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new AppError(`${field} must be a non-empty relative path inside the source repository.`, 400, "SWARM_SOURCE_PATH_INVALID");
  }
  return normalized;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateInlineYaml(yaml: string): string {
  if (!yaml.trim()) throw new AppError("Inline stack YAML cannot be empty.", 400, "SWARM_SOURCE_INVALID");
  if (Buffer.byteLength(yaml, "utf8") > MAX_INLINE_STACK_SOURCE_BYTES) {
    throw new AppError("Inline stack YAML exceeds the 1 MB source limit.", 400, "SWARM_SOURCE_TOO_LARGE");
  }
  const doc = parseDocument(yaml, { prettyErrors: false });
  if (doc.errors.length > 0) {
    throw new AppError("Inline stack YAML is not valid YAML.", 400, "SWARM_SOURCE_INVALID");
  }
  const document = doc.toJSON();
  if (!document || typeof document !== "object" || Array.isArray(document) || !Object.hasOwn(document, "services")) {
    throw new AppError("A stack source must contain a top-level services mapping.", 400, "SWARM_SOURCE_INVALID");
  }
  const services = (document as Record<string, unknown>).services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    throw new AppError("Stack services must be a mapping.", 400, "SWARM_SOURCE_INVALID");
  }
  return yaml;
}

function assertExpectedVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError("Source version must be a positive integer.", 400, "SWARM_SOURCE_VERSION_INVALID");
  }
  return value;
}

export function validateStackSource(input: StackSourceInput): ValidatedStackSource {
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  if (input.kind === "inline") {
    const yaml = validateInlineYaml(input.yaml);
    return {
      kind: "inline", sourcePaths: [], sourcePath: null, sourceBranch: null, sourceCommitSha: null,
      inlineYaml: yaml, sourceDigest: digest(yaml), expectedVersion,
    };
  }
  if (input.kind === "repository") {
    const sourcePaths = input.composePaths.map((path) => assertRelativeSourcePath(path, "composePaths"));
    if (sourcePaths.length === 0 || new Set(sourcePaths).size !== sourcePaths.length) {
      throw new AppError("Repository source must contain one or more unique ordered compose paths.", 400, "SWARM_SOURCE_PATH_INVALID");
    }
    const sourcePath = input.sourcePath ? assertRelativeSourcePath(input.sourcePath, "sourcePath") : null;
    const sourceBranch = input.branch?.trim() || null;
    const sourceCommitSha = input.commitSha?.trim() || null;
    if (sourceBranch && /[\r\n\0]/.test(sourceBranch)) {
      throw new AppError("Source branch contains invalid control characters.", 400, "SWARM_SOURCE_INVALID");
    }
    if (sourceCommitSha && !/^[0-9a-f]{7,64}$/i.test(sourceCommitSha)) {
      throw new AppError("Source commit must be a Git SHA.", 400, "SWARM_SOURCE_INVALID");
    }
    return {
      kind: "repository", sourcePaths, sourcePath, sourceBranch, sourceCommitSha, inlineYaml: null,
      sourceDigest: digest(JSON.stringify({ sourcePaths, sourcePath, sourceBranch, sourceCommitSha })), expectedVersion,
    };
  }
  return {
    kind: "adopted", sourcePaths: [], sourcePath: null, sourceBranch: null, sourceCommitSha: null,
    inlineYaml: null, sourceDigest: null, expectedVersion,
  };
}

export function serializeStackSource(stack: SwarmStack) {
  const deployable = stack.sourceKind === "inline"
    ? !!stack.sourceYamlEnc
    : stack.sourceKind === "repository" && stack.sourcePaths.length > 0;
  return {
    kind: stack.sourceKind,
    status: stack.sourceStatus,
    composePaths: stack.sourcePaths,
    sourcePath: stack.sourcePath,
    branch: stack.sourceBranch,
    commitSha: stack.sourceCommitSha,
    version: stack.sourceVersion,
    digest: stack.sourceDigest,
    deployable,
    routingMode: stack.routingMode,
    registryId: stack.registryId,
    storageAcknowledgements: stack.storageAcknowledgements,
    volumeReplacementAcknowledgements: stack.volumeReplacementAcknowledgements,
    // Presence only: encrypted source text is never part of the normal DTO.
    hasInlineYaml: !!stack.sourceYamlEnc,
  };
}
