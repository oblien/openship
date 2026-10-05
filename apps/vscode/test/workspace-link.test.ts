import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRemoteLink,
  linkPath,
  matchingBinding,
  parseProjectLink,
  readNearestLink,
  writeProjectLink,
} from "../src/workspace-link";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "openship-vscode-link-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace project links", () => {
  it("finds a parent CLI link and invalidates its binding if the context changes", async () => {
    const root = await directory();
    const loaded = await writeProjectLink(root, { projectId: "p1", context: "first" }, null);
    const child = join(root, "apps", "web");
    await mkdir(child, { recursive: true });
    expect(await readNearestLink(child)).toEqual(loaded);
    const binding = {
      ...loaded,
      connectionId: "connection-a",
      projectId: "p1",
      organizationId: "org-a",
    };
    expect(matchingBinding(binding, loaded)?.connectionId).toBe("connection-a");
    await writeFile(loaded.path, JSON.stringify({ projectId: "p1", context: "second" }));
    expect(matchingBinding(binding, (await readNearestLink(child))!)).toBeUndefined();
  });

  it("keeps sibling workspace folders linked independently", async () => {
    const root = await directory();
    await writeProjectLink(join(root, "one"), { projectId: "p1" }, null);
    await writeProjectLink(join(root, "two"), { projectId: "p2" }, null);
    expect((await readNearestLink(join(root, "one")))?.link.projectId).toBe("p1");
    expect((await readNearestLink(join(root, "two")))?.link.projectId).toBe("p2");
  });

  it("rejects native and malformed links without falling back to a remote connection", () => {
    expect(() =>
      assertRemoteLink(
        parseProjectLink('{"projectId":"p1","native":{"instanceId":"i1","organizationId":"o1"}}'),
      ),
    ).toThrow("native");
    for (const text of [
      "[]",
      "{",
      '{"projectId":42}',
      '{"native":null}',
      '{"native":{"instanceId":"i1"}}',
    ]) {
      expect(() => parseProjectLink(text)).toThrow();
    }
    expect(() => assertRemoteLink({ context: "default" })).toThrow("no project ID");
  });

  it("does not overwrite an intervening edit", async () => {
    const root = await directory();
    const loaded = await writeProjectLink(root, { projectId: "p1" }, null);
    const original = await readFile(loaded.path, "utf8");
    await writeFile(loaded.path, '{"projectId":"edited"}');
    await expect(writeProjectLink(root, { projectId: "p2" }, original)).rejects.toThrow(
      "changed while selecting",
    );
    expect(await readFile(linkPath(root), "utf8")).toBe('{"projectId":"edited"}');
  });

  it("does not write through a symlinked metadata directory", async () => {
    const root = await directory();
    const outside = await directory();
    await symlink(outside, join(root, ".openship"), "dir");
    await expect(writeProjectLink(root, { projectId: "p1" }, null)).rejects.toThrow("symlink");
    await expect(readFile(join(outside, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
