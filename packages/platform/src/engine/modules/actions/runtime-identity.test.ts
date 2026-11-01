import { describe, expect, it, vi } from "vitest";
import { ActionRuntimeTokens } from "./runtime-identity";

describe("Actions runtime capabilities", () => {
  const identity = {
    organizationId: "org-one",
    runId: "run-one",
    jobId: "job-one",
    purpose: "runtime" as const,
  };
  const tokens = new ActionRuntimeTokens("controller-signing-secret");
  it("rejects modified, expired, wrong-purpose and foreign-controller credentials", async () => {
    const token = await tokens.issue(identity, 60);
    expect(await tokens.verify(token, "runtime")).toMatchObject(identity);
    await expect(tokens.verify(token, "download")).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      new ActionRuntimeTokens("different-controller").verify(token, "runtime"),
    ).rejects.toMatchObject({ statusCode: 401 });
    const parts = token.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({
        ...identity,
        organizationId: "another-org",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    await expect(tokens.verify(parts.join("."), "runtime")).rejects.toMatchObject({
      statusCode: 401,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await expect(tokens.verify(token, "runtime")).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("requires an object and the current viewer's organization for signed downloads", async () => {
    const missingObject = await tokens.issue({ ...identity, purpose: "download" }, 60);
    await expect(tokens.verify(missingObject, "download")).rejects.toMatchObject({
      statusCode: 401,
    });
    const wrongViewer = await tokens.issue(
      {
        ...identity,
        purpose: "user-download",
        objectId: 1,
        viewer: {
          version: 1,
          userId: "user",
          organizationId: "other",
          token: null,
          restrictions: null,
        },
      },
      60,
    );
    await expect(tokens.verify(wrongViewer, "user-download")).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(tokens.issue(identity, 999999)).rejects.toThrow("lifetime");
  });
});
