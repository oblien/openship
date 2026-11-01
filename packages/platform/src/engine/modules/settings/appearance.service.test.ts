import { beforeEach, expect, it, vi } from "vitest";
import { createTheme, defaultAppearance } from "@repo/core";
const m = vi.hoisted(() => ({
  getAppearance: vi.fn(),
  setAppearance: vi.fn(),
  recordAsync: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { settings: m } }));
vi.mock("../../lib/audit-emitter", () => ({
  audit: { recordAsync: m.recordAsync },
  operationAuditContext: (ctx: unknown) => ctx,
}));
import { getAppearance, setAppearance } from "./appearance.service";
const ctx = { userId: "alice" } as never;
beforeEach(() => {
  vi.clearAllMocks();
  m.getAppearance.mockResolvedValue(null);
});
it("reads personal state without accepting a user selector", async () => {
  await expect(getAppearance(ctx)).resolves.toEqual({ appearance: null });
  expect(m.getAppearance).toHaveBeenCalledWith("alice");
});
it("does not disguise a failed read as editable defaults", async () => {
  m.getAppearance.mockRejectedValue(new Error("database unavailable"));
  await expect(getAppearance(ctx)).rejects.toThrow("database unavailable");
});
it("rejects invalid tokens before persistence and audits metadata only", async () => {
  const theme = createTheme("light", "personal", "Personal");
  const appearance = { ...defaultAppearance("personal"), themes: [theme] };
  await expect(
    setAppearance(ctx, {
      appearance: {
        ...appearance,
        themes: [{ ...theme, tokens: { "--th-bg-page": "url(https://bad.test)" } }],
      },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(m.setAppearance).not.toHaveBeenCalled();
  await setAppearance(ctx, { appearance });
  expect(m.setAppearance).toHaveBeenCalledWith("alice", appearance);
  expect(JSON.stringify(m.recordAsync.mock.calls)).not.toContain("typography");
});
