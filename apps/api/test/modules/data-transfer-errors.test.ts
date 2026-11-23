import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { db, schema, RestoreSchemaError } from "@repo/db";
import { readSseTerminalEvent } from "@repo/core";

const h = vi.hoisted(() => ({ importInstance: vi.fn(), finalizeFileUpload: vi.fn(), exportInstance: vi.fn(), previewInstanceExport: vi.fn() }));
vi.mock("../../src/modules/system/data-transfer/export.service", async (original) => ({
  ...await original<typeof import("../../src/modules/system/data-transfer/export.service")>(),
  exportInstance: h.exportInstance,
  previewInstanceExport: h.previewInstanceExport,
}));
vi.mock("../../src/modules/system/data-transfer/import.service", async (original) => ({
  ...await original<typeof import("../../src/modules/system/data-transfer/import.service")>(),
  importInstance: h.importInstance,
}));
vi.mock("../../src/modules/system/data-transfer/file-upload.service", async (original) => ({
  ...await original<typeof import("../../src/modules/system/data-transfer/file-upload.service")>(),
  finalizeFileUpload: h.finalizeFileUpload,
}));

import {
  importInstanceHandler,
  finalizeFileUploadStreamHandler,
  exportInstanceHandler,
  previewInstanceExportHandler,
} from "../../src/modules/system/data-transfer/data-transfer.controller";
import { handleApiError } from "../../src/middleware/error-handler";

const app = new Hono();
app.onError(handleApiError);
app.use("*", async (c, next) => {
  c.set("ctx" as never, { userId: "transfer-admin", organizationId: "workspace" } as never);
  await next();
});
app.post("/import", importInstanceHandler);
app.post("/uploads/:sessionId/finalize", finalizeFileUploadStreamHandler);
app.post("/export", exportInstanceHandler);
app.post("/export/preview", previewInstanceExportHandler);

beforeAll(async () => {
  await db.insert(schema.user).values({
    id: "transfer-admin", name: "Administrator", email: "transfer@example.test", role: "admin",
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  const error = new RestoreSchemaError(new Error("private SQL: credential=must-not-leak"));
  h.importInstance.mockRejectedValue(error);
  h.finalizeFileUpload.mockRejectedValue(error);
  h.exportInstance.mockResolvedValue({ dump: { tables: {} } });
  h.previewInstanceExport.mockResolvedValue({});
});

it.each(["/export", "/export/preview"])("does not turn a malformed selection into a full instance export at %s", async path => {
  const response = await app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"selection":',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "INVALID_JSON" });
  expect(h.exportInstance).not.toHaveBeenCalled();
  expect(h.previewInstanceExport).not.toHaveBeenCalled();
});

it.each(["json", "stream"])("returns an actionable schema error through %s without exposing database values", async (transport) => {
  const response = await app.request(transport === "json" ? "/import" : "/uploads/session/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: {}, mode: "wipe" }),
  });
  let failure: { status?: number; code: string; error: string };
  if (transport === "stream") {
    expect(response.status).toBe(200);
    const terminal = await readSseTerminalEvent(response.body!);
    expect(terminal.event).toBe("error");
    failure = JSON.parse(terminal.data);
    expect(failure.status).toBe(409);
  } else {
    expect(response.status).toBe(409);
    failure = await response.json();
  }
  expect(failure.code).toBe("DESTINATION_SCHEMA_MISMATCH");
  expect(failure.error).toContain("database migrations");
  expect(JSON.stringify(failure)).not.toMatch(/private SQL|credential|must-not-leak/);
});
