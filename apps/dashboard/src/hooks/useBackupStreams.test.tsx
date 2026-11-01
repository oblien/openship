// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackupRunStream } from "./useBackupRunStream";
import { useRestoreRunStream } from "./useRestoreRunStream";

vi.mock("@/lib/api/client", () => ({
  getApiBaseUrl: () => "http://localhost:4000/api/",
  getActiveOrganizationId: () => "org-backups",
}));

function response(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
    cancel() {
      closed = true;
    },
  });
  signal.addEventListener(
    "abort",
    () => {
      if (!closed) {
        closed = true;
        controller.error(new DOMException("Aborted", "AbortError"));
      }
    },
    { once: true },
  );
  return {
    value: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    send: (event: object) =>
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    end() {
      closed = true;
      controller.close();
    },
  };
}

type Kind = "backup" | "restore";
const fetcher = vi.fn<typeof fetch>();
const opened: ReturnType<typeof response>[] = [];
let root: Root;
let element: HTMLDivElement;
let backup: ReturnType<typeof useBackupRunStream>;
let restore: ReturnType<typeof useRestoreRunStream>;
function Harness({ kind, id }: { kind: Kind; id: string | null }) {
  backup = useBackupRunStream(kind === "backup" ? id : null);
  restore = useRestoreRunStream(kind === "restore" ? id : null);
  return null;
}
const render = (kind: Kind, id: string | null = "run-one") =>
  act(async () => root.render(<Harness kind={kind} id={id} />));
const snapshot = (kind: Kind, status = "preparing", id = "run-one") => ({
  type: "snapshot",
  [kind === "backup" ? "run" : "restore"]: { id, status },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  opened.length = 0;
  fetcher.mockReset().mockImplementation(async (_url, options) => {
    const live = response(options!.signal!);
    opened.push(live);
    return live.value;
  });
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("backup and restore progress", () => {
  it("applies upload progress and the terminal verdict using only a scoped GET", async () => {
    await render("backup");
    await act(async () => {
      opened[0].send(snapshot("backup"));
      opened[0].send({ type: "transition", status: "uploading" });
      opened[0].send({ type: "progress", bytesTransferred: 1234 });
    });
    expect(backup.run).toMatchObject({
      id: "run-one",
      status: "uploading",
      bytesTransferred: 1234,
    });
    expect(fetcher.mock.calls[0]).toMatchObject([
      "http://localhost:4000/api/backup-runs/run-one/stream",
      { method: "GET", credentials: "include", headers: { "X-Organization-Id": "org-backups" } },
    ]);
    await act(async () =>
      opened[0].send({ type: "complete", status: "failed", errorMessage: "Storage filled up" }),
    );
    expect(backup.run).toMatchObject({ status: "failed", errorMessage: "Storage filled up" });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains restore advisories and reports partial writes from live terminal events", async () => {
    await render("restore");
    await act(async () => {
      opened[0].send(snapshot("restore"));
      opened[0].send({ type: "warning", message: "Legacy backup has no checksum" });
      opened[0].send({ type: "warning", message: "Legacy backup has no checksum" });
      opened[0].send({
        type: "transition",
        status: "prepared",
        bytesRestored: 900,
        meta: { integrity: "size-only" },
      });
    });
    expect(restore.warnings).toEqual(["Legacy backup has no checksum"]);
    expect(restore.restore).toMatchObject({
      status: "prepared",
      bytesRestored: 900,
      meta: { integrity: "size-only" },
    });
    await act(async () => {
      opened[0].send({ type: "transition", status: "applying" });
      opened[0].send({ type: "destructive", destructive: true, cancelRequested: true });
    });
    expect(restore.restore).toMatchObject({ cancelRequested: true, meta: { destructive: true } });
    await act(async () => {
      opened[0].send({
        type: "transition",
        status: "cancelled",
        meta: { partialWrite: true, serviceLeftStopped: true },
      });
      opened[0].send({
        type: "complete",
        status: "cancelled",
        errorMessage: "Cancelled with partial data",
      });
    });
    expect(restore.restore).toMatchObject({
      status: "cancelled",
      meta: { partialWrite: true, serviceLeftStopped: true },
    });
    expect(restore.reconnecting).toBe(false);
  });

  it.each(["backup", "restore"] as const)(
    "reconnects %s progress and resets state when its target changes",
    async (kind) => {
      await render(kind);
      await act(async () => {
        opened[0].send(snapshot(kind));
        opened[0].end();
      });
      expect((kind === "backup" ? backup : restore).reconnecting).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await act(async () => opened[1].send(snapshot(kind, "succeeded")));
      expect((kind === "backup" ? backup.run : restore.restore)?.status).toBe("succeeded");
      await render(kind, "run-two");
      expect(kind === "backup" ? backup.run : restore.restore).toBeNull();
      expect(fetcher.mock.calls[1][1]!.signal!.aborted).toBe(true);
      await act(async () => opened[2].send(snapshot(kind, "preparing", "run-two")));
      expect((kind === "backup" ? backup.run : restore.restore)?.id).toBe("run-two");
      await render(kind, null);
      expect(kind === "backup" ? backup.run : restore.restore).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(
        fetcher.mock.calls.every(([, request]) => request?.method === "GET" && !request.body),
      ).toBe(true);
    },
  );

  it("stops automatic retries on forbidden restore access and permits an explicit reconnect", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "Restore access denied" }, { status: 403 }),
    );
    await render("restore");
    expect(restore.error?.message).toContain("Restore access denied");
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => restore.reconnect());
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => opened[0].send(snapshot("restore")));
    expect(restore.error).toBeNull();
  });

  it.each(["backup", "restore"] as const)(
    "uses reconciled %s snapshots through completion on the same connection",
    async kind => {
      await render(kind);
      const key = kind === "backup" ? "run" : "restore";
      await act(async () => {
        opened[0].send(snapshot(kind));
        opened[0].send({ type: "ping" });
        opened[0].send(snapshot(kind, kind === "backup" ? "uploading" : "applying"));
      });
      const finishedAt = "2026-09-25T11:06:00.042Z";
      await act(async () => {
        opened[0].send({ type: "snapshot", [key]: {
          id: "run-one", status: "succeeded", finishedAt, lastEventAt: finishedAt,
          ...(kind === "backup" ? { bytesTransferred: 54_449_050 } : { bytesRestored: 54_449_050 }),
        } });
        opened[0].send({ type: "complete", status: "succeeded" });
      });
      expect(kind === "backup" ? backup.run : restore.restore).toMatchObject({
        status: "succeeded", finishedAt,
        ...(kind === "backup" ? { bytesTransferred: 54_449_050 } : { bytesRestored: 54_449_050 }),
      });
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
});
