import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isProjectReference, isRecord, type ProjectReference } from "./model";

/** Compatible with the link written by openship init; never contains a token. */
export interface ProjectLink {
  projectId?: string;
  branch?: string;
  name?: string;
  slug?: string;
  context?: string;
  native?: { instanceId: string; organizationId: string };
  defaults?: { environment: string };
}

export interface LoadedLink {
  path: string;
  fingerprint: string;
  link: ProjectLink;
}

export interface WorkspaceBinding extends ProjectReference {
  path: string;
  fingerprint: string;
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function readLinkText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export function parseProjectLink(text: string): ProjectLink {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid JSON in .openship/project.json. Use Openship: Link Workspace to Project to replace the link.",
    );
  }
  if (!isRecord(value)) throw new Error("The Openship project link must be an object.");
  for (const field of ["projectId", "branch", "name", "slug", "context"]) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !(value[field] as string).trim())
    ) {
      throw new Error(`Invalid ${field} in .openship/project.json.`);
    }
  }
  if (
    value.native !== undefined &&
    (!isRecord(value.native) ||
      typeof value.native.instanceId !== "string" ||
      !value.native.instanceId ||
      typeof value.native.organizationId !== "string" ||
      !value.native.organizationId)
  ) {
    throw new Error("Invalid native instance in .openship/project.json. Link the workspace again.");
  }
  if (
    value.defaults !== undefined &&
    (!isRecord(value.defaults) || typeof value.defaults.environment !== "string")
  ) {
    throw new Error("Invalid defaults in .openship/project.json.");
  }
  return value as ProjectLink;
}

export const linkPath = (folder: string) => join(folder, ".openship", "project.json");

export async function readNearestLink(folder: string): Promise<LoadedLink | undefined> {
  if (!isAbsolute(folder))
    throw new Error("The workspace folder must have an absolute filesystem path.");
  for (let current = resolve(folder); ; current = dirname(current)) {
    const path = linkPath(current);
    const text = await readLinkText(path);
    if (text !== null)
      return {
        path,
        fingerprint: createHash("sha256").update(text).digest("hex"),
        link: parseProjectLink(text),
      };
    if (dirname(current) === current) return;
  }
}

export function matchingBinding(value: unknown, loaded: LoadedLink): WorkspaceBinding | undefined {
  if (
    !isProjectReference(value) ||
    !isRecord(value) ||
    loaded.link.native ||
    value.path !== loaded.path ||
    value.fingerprint !== loaded.fingerprint ||
    value.projectId !== loaded.link.projectId
  )
    return;
  return value as unknown as WorkspaceBinding;
}

export function assertRemoteLink(
  link: ProjectLink,
): asserts link is ProjectLink & { projectId: string } {
  if (link.native)
    throw new Error(
      "This workspace is linked to a native Openship instance. This extension uses an HTTP connection. Run Openship: Link Workspace to Project to select a remote project.",
    );
  if (!link.projectId)
    throw new Error(
      "The workspace link has no project ID. Run Openship: Link Workspace to Project.",
    );
}

/** Refuse an intervening edit and replace atomically, without following a link file symlink. */
export async function writeProjectLink(
  folder: string,
  link: ProjectLink,
  expected: string | null,
): Promise<LoadedLink> {
  const path = linkPath(folder);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error(
      "The .openship directory is a symlink. Use a directory inside this workspace for its project link.",
    );
  const temporary = join(directory, `.project-${randomUUID()}.tmp`);
  const text = JSON.stringify(link, null, 2) + "\n";
  parseProjectLink(text);
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    if ((await readLinkText(path)) !== expected)
      throw new Error(
        "The project link changed while selecting a project. Run Link Workspace again.",
      );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, fingerprint: createHash("sha256").update(text).digest("hex"), link };
}
