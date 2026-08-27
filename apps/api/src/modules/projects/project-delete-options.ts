import { AppError } from "@repo/core";

export interface ProjectDeleteOptions {
  force: boolean;
  forceOrphan: boolean;
  wipeVolumes: boolean;
  recordOnly: boolean;
}

type DeleteOptionName = keyof ProjectDeleteOptions;

/** `orphan` is the legacy spelling clients used before `forceOrphan` was named. */
export type ProjectDeleteQuery = Partial<Record<DeleteOptionName | "orphan", string>>;

function bodyRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Project delete body must be a JSON object", 400, "INVALID_DELETE_OPTIONS");
  }
  return body as Record<string, unknown>;
}

function parseDeleteBoolean(
  name: DeleteOptionName,
  queryValue: string | undefined,
  bodyValue: unknown,
): boolean {
  // An explicitly supplied query parameter is authoritative, including false.
  // This keeps old query-based clients deterministic when they also send a body.
  if (queryValue !== undefined) {
    if (queryValue === "true") return true;
    if (queryValue === "false") return false;
    throw new AppError(
      `${name} query parameter must be "true" or "false"`,
      400,
      "INVALID_DELETE_OPTIONS",
    );
  }

  if (bodyValue === undefined) return false;
  if (typeof bodyValue === "boolean") return bodyValue;
  throw new AppError(
    `${name} in the request body must be a boolean`,
    400,
    "INVALID_DELETE_OPTIONS",
  );
}

/**
 * Parse DELETE /projects/:id flags from either transport used by clients.
 * Query values win when both are present. `forceOrphan` necessarily implies
 * `force`: the service must first cancel active work before it may orphan and
 * remove the project record.
 */
export function parseProjectDeleteOptions(
  query: ProjectDeleteQuery,
  body: unknown,
): ProjectDeleteOptions {
  const record = bodyRecord(body);
  const forceOrphan = parseDeleteBoolean(
    "forceOrphan",
    query.forceOrphan ?? query.orphan,
    record.forceOrphan ?? record.orphan,
  );

  const options = {
    force: parseDeleteBoolean("force", query.force, record.force) || forceOrphan,
    forceOrphan,
    wipeVolumes: parseDeleteBoolean("wipeVolumes", query.wipeVolumes, record.wipeVolumes),
    recordOnly: parseDeleteBoolean("recordOnly", query.recordOnly, record.recordOnly),
  };
  if (options.recordOnly && (options.wipeVolumes || options.forceOrphan)) {
    throw new AppError(
      "recordOnly cannot be combined with wipeVolumes or forceOrphan",
      400,
      "INVALID_DELETE_OPTIONS",
    );
  }
  return options;
}
