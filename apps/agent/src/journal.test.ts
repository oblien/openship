import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationJournal, foldJournal, incompleteEntries } from "./journal";

describe("journal recover", () => {
  it("folds append-only lines so the last status for an id wins", () => {
    const lines = [
      JSON.stringify({
        id: "op_1",
        op: "execute_release",
        payload: { sha: "aaa" },
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        id: "op_1",
        op: "execute_release",
        payload: { sha: "aaa" },
        status: "done",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        result: { ok: true },
      }),
      JSON.stringify({
        id: "op_2",
        op: "renew_certs",
        payload: {},
        status: "pending",
        startedAt: "2026-01-01T00:02:00.000Z",
      }),
      "not-json",
      "",
    ];
    const folded = foldJournal(lines);
    expect(folded.get("op_1")?.status).toBe("done");
    expect(incompleteEntries(folded).map((e) => e.id)).toEqual(["op_2"]);
  });

  it("replays only incomplete rows after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "osh-agent-journal-"));
    const path = join(dir, "journal.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          id: "op_done",
          op: "ping",
          payload: {},
          status: "done",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
        }),
        JSON.stringify({
          id: "op_mid",
          op: "execute_release",
          payload: { sha: "abc" },
          status: "running",
          startedAt: "2026-01-01T00:01:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    const journal = new OperationJournal(path);
    const incomplete = incompleteEntries(journal.readAll());
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.id).toBe("op_mid");
    expect(journal.isDone("op_done")).toBe(true);
    expect(journal.isDone("op_mid")).toBe(false);

    journal.finish("op_mid", { ok: true, recovered: true });
    expect(journal.isDone("op_mid")).toBe(true);
    expect(incompleteEntries(journal.readAll())).toEqual([]);
  });
});
