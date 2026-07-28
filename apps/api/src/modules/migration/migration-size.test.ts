import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import { sizeOfMoveSet } from "./migration-size";

/** Fake executor: `exec` replies from a (cmd → string) responder; a responder
 *  returning `THROW` simulates a timeout/failure (the real code `.catch`es). */
function fakeExec(reply: (cmd: string) => string): CommandExecutor {
  return {
    async exec(command: string) {
      const r = reply(command);
      if (r === "THROW") throw new Error("timed out");
      return r;
    },
    streamExec: async () => ({ code: 0, output: "" }),
  } as unknown as CommandExecutor;
}

describe("sizeOfMoveSet", () => {
  test("sums volume (mountpoint→du), bind (du), and image (inspect) sizes", async () => {
    const exec = fakeExec((cmd) => {
      if (cmd.includes("docker volume inspect") && cmd.includes("Mountpoint")) return "/mnt/vol1";
      if (cmd.includes("du -sb") && cmd.includes("/mnt/vol1")) return "1000";
      if (cmd.includes("du -sb") && cmd.includes("/data")) return "200";
      if (cmd.includes("docker image inspect") && cmd.includes("Size")) return "30";
      if (cmd.includes("du -sb") && cmd.includes("/opt/extra")) return "7";
      return "";
    });
    const res = await sizeOfMoveSet(exec, {
      volumeNames: ["vol1"],
      bindPaths: ["/data"],
      images: [{ id: "sha256:img1", tag: "app:1" }],
      customPaths: ["/opt/extra"],
    });
    expect(res.totalBytes).toBe(1237);
    expect(res.partial).toBe(false);
    expect(res.perItem).toHaveLength(4);
    expect(res.perItem.find((i) => i.kind === "volume")?.bytes).toBe(1000);
    // Image is probed by id but reported under its tag.
    const img = res.perItem.find((i) => i.kind === "image");
    expect(img?.bytes).toBe(30);
    expect(img?.ref).toBe("app:1");
    expect(res.perItem.find((i) => i.kind === "path")?.bytes).toBe(7);
  });

  test("an unmeasurable item → bytes null, partial true, total is a lower bound", async () => {
    const exec = fakeExec((cmd) => {
      if (cmd.includes("docker volume inspect")) return "/mnt/vol1";
      if (cmd.includes("du -sb") && cmd.includes("/mnt/vol1")) return "THROW"; // stuck du
      if (cmd.includes("du -sb") && cmd.includes("/data")) return "500";
      return "";
    });
    const res = await sizeOfMoveSet(exec, { volumeNames: ["vol1"], bindPaths: ["/data"], images: [] });
    expect(res.perItem.find((i) => i.kind === "volume")?.bytes).toBeNull();
    expect(res.partial).toBe(true);
    expect(res.totalBytes).toBe(500); // only the measurable bind counts
  });

  test("empty move-set → zero", async () => {
    const res = await sizeOfMoveSet(fakeExec(() => ""), { volumeNames: [], bindPaths: [], images: [] });
    expect(res).toEqual({ perItem: [], totalBytes: 0, partial: false });
  });
});
