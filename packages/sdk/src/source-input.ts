import { ValidationError } from "@repo/contracts";

export interface DeploySourceInput {
  source:
    | { type: "directory"; path: string }
    | { type: "files"; files: Readonly<Record<string, string | Uint8Array>> };
  name?: string;
  projectId?: string;
  environment?: "production" | "preview";
  serverId?: string;
  serviceIds?: string[];
  signal?: AbortSignal;
  onStep?: (message: string) => void;
}

export interface SourceDeploymentResult {
  deployment_id: string;
  project_id: string;
  configDiagnostics?: { errors: string[]; warnings: string[]; wholeFile?: true };
}

/** Capture public inputs before asynchronous module loading, I/O, or identity checks. */
export function snapshotSourceInput(input: DeploySourceInput): DeploySourceInput {
  if (!input || typeof input !== "object") throw new ValidationError("A deployment source is required");
  const { source, name, projectId, environment, serverId, signal, onStep } = input ?? {};
  for (const value of [name, projectId, serverId])
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      throw new ValidationError("Names and identifiers must be nonempty strings");
  if (environment !== undefined && environment !== "production" && environment !== "preview")
    throw new ValidationError("Invalid deployment environment");
  if (input.serviceIds !== undefined && (!Array.isArray(input.serviceIds) || input.serviceIds.some((id) => typeof id !== "string" || !id)))
    throw new ValidationError("serviceIds must contain nonempty identifiers");
  let snapshot: DeploySourceInput["source"];
  if (source?.type === "directory" && typeof source.path === "string" && source.path.trim()) {
    snapshot = { type: "directory", path: source.path };
  } else if (source?.type === "files" && source.files && typeof source.files === "object" && !Array.isArray(source.files)) {
    const files = Object.fromEntries(Object.entries(source.files).map(([path, value]) => {
      if (typeof value !== "string" && !(value instanceof Uint8Array))
        throw new ValidationError("Generated file contents must be strings or Uint8Array values");
      return [path, typeof value === "string" ? value : new Uint8Array(value)];
    }));
    snapshot = { type: "files", files };
  } else {
    throw new ValidationError("A directory or generated files source is required");
  }
  return { source: snapshot, name, projectId, environment, serverId, signal, onStep, serviceIds: input.serviceIds ? [...input.serviceIds] : undefined };
}
