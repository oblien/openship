import { beforeEach, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../../context";
import { reusableSourceReader } from "./reusable-source";

const h = vi.hoisted(() => ({ authorize: vi.fn(), fetch: vi.fn(), file: vi.fn() }));
vi.mock("./access", () => ({ authorizeActionRepository: h.authorize }));
vi.mock("../github/github.auth", () => ({ githubFetch: h.fetch }));
vi.mock("../github/github.service", () => ({ getFileContent: h.file }));
const caller = {
  owner: "acme",
  repo: "app",
  path: ".openship/workflows/ci.yml",
  source: "",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
};
const ctx = {} as ExecutionContext;
beforeEach(() => {
  vi.resetAllMocks();
  h.file.mockResolvedValue({ content: "called-source" });
});

it("fetches local calls at the caller's immutable commit", async () => {
  const value = await reusableSourceReader(ctx)("./.openship/workflows/build.yml", caller);
  expect(value.sha).toBe(caller.sha);
  expect(h.file).toHaveBeenCalledWith(ctx, "acme", "app", ".openship/workflows/build.yml", {
    branch: caller.sha,
  });
  expect(h.fetch).not.toHaveBeenCalled();
});
it.each(["v1", "refs/heads/main", "refs/tags/v1"])(
  "resolves %s without confusing an explicit branch with a tag",
  async (ref) => {
    h.fetch.mockImplementation(async ({ url }) =>
      url.includes("/matching-refs/")
        ? [{ ref: ref.startsWith("refs/") ? ref : "refs/tags/v1" }]
        : { sha: "b".repeat(40) },
    );
    const value = await reusableSourceReader(ctx)(
      `acme/library/.github/workflows/build.yml@${ref}`,
      caller,
    );
    expect(value.sha).toBe("b".repeat(40));
    expect(h.file.mock.calls[0]![4]).toEqual({ branch: "b".repeat(40) });
    if (ref.startsWith("refs/heads/"))
      expect(h.fetch.mock.calls[0]![0].url).toContain("matching-refs/heads/main");
    else expect(h.fetch.mock.calls[0]![0].url).toContain("matching-refs/tags/v1");
  },
);
it("authorizes private reusable repositories and never fetches arbitrary URLs", async () => {
  h.authorize.mockRejectedValueOnce(new Error("Repository not granted"));
  await expect(
    reusableSourceReader(ctx)("private/library/.github/workflows/build.yml@v1", caller),
  ).rejects.toThrow("not granted");
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.file).not.toHaveBeenCalled();
  await expect(
    reusableSourceReader(ctx)("https://internal.example/workflow.yml", caller),
  ).rejects.toThrow("Invalid reusable");
});
