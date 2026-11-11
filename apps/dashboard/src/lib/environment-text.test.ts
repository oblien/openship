import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import { environmentFromText, environmentToText } from "./environment-text";
import { computeProjectEnvDiff, createProjectEnvEditState } from "./project-env-diff";

describe("environment text edits", () => {
  it("retains saved secret identities and emits only the intended project diff", () => {
    const { rows, baseline } = createProjectEnvEditState([
      { key: "TOKEN", value: ENV_MASK, isSecret: true, environment: "production" },
      { key: "PORT", value: "3000", isSecret: false, environment: "production" },
      { key: "OLD", value: "remove", isSecret: false, environment: "production" },
    ]);
    const text = environmentToText(rows);
    expect(text).toContain(`TOKEN=${ENV_MASK}`);
    const next = environmentFromText(
      text.replace("PORT=3000", "PORT=4000").replace("OLD=remove\n", ""),
      rows,
    );
    expect(next[0]).toEqual(rows[0]);
    expect(computeProjectEnvDiff(next, baseline)).toEqual({
      ok: true,
      diff: {
        upserts: [{ key: "PORT", value: "4000", isSecret: false }],
        deletes: ["OLD"],
      },
    });
    const cleared = environmentFromText(`TOKEN=\n`, rows);
    expect(computeProjectEnvDiff(cleared, baseline)).toEqual({
      ok: true,
      diff: {
        upserts: [{ key: "TOKEN", value: "", isSecret: true }],
        deletes: ["PORT", "OLD"],
      },
    });
  });

  it("round-trips complex values and service metadata without interpolation", () => {
    const rows = [
      {
        key: "DATABASE_URL",
        value: "postgres://a:p@db/x?a=1&b=2",
        visible: false,
        sourceId: "service-id",
        originLabel: "Compose",
        isSecret: true,
        keyReadOnly: true,
        removalDisabled: true,
      },
      {
        key: "TEXT",
        value: "  #quotes 'and\" \\path\nNEXT=still-value\r\n${LITERAL}  ",
        visible: true,
      },
    ];
    expect(environmentFromText(environmentToText(rows), rows)).toEqual(rows);
    const next = environmentFromText('DATABASE_URL=changed\nTEXT="new"', rows);
    expect(next[0]).toMatchObject({
      ...rows[0],
      value: "changed",
      visible: true,
      preserveValue: false,
    });
    expect(() => environmentFromText("TEXT=new", rows)).toThrow();
  });

  it("protects linked variables and rejects orphaned mask placeholders", () => {
    const rows = [{ key: "DB", value: ENV_MASK, visible: false }];
    expect(() => environmentFromText(`RENAMED=${ENV_MASK}`, rows)).toThrow();
    expect(() => environmentFromText("DB=changed", rows, ["DB"])).toThrow();
    expect(() => environmentFromText("", rows, ["DB"])).toThrow();
    expect(environmentFromText(`DB=${ENV_MASK}\nNEW=value`, rows, ["DB"])[0]).toEqual(rows[0]);
  });

  it.each([
    "PORT=3000\nPORT=4000",
    "1INVALID=x",
    "PORT=3000\nnot an assignment",
    'A="unterminated',
    'A="value"junk',
    "A=before\0after",
  ])("rejects invalid text without producing a partial replacement: %s", (text) => {
    expect(() => environmentFromText(text, [])).toThrow();
  });

  it("accepts comments, exports, multiline literals and deliberate removal", () => {
    expect(
      environmentFromText(
        "# note\r\nexport TOKEN='${LITERAL}'\r\nKEY='first\nSECOND=part of value'",
        [],
      ),
    ).toEqual([
      { key: "TOKEN", value: "${LITERAL}", preserveValue: false, visible: true },
      { key: "KEY", value: "first\nSECOND=part of value", preserveValue: false, visible: true },
    ]);
    expect(
      environmentFromText("# remove all editable variables", [
        { key: "PORT", value: "3000", visible: true },
      ]),
    ).toEqual([]);
    expect(environmentToText([{ key: "", value: "", visible: true }])).toBe("");
    expect(() =>
      environmentToText([{ key: "", originalKey: "PORT", value: "", visible: true }]),
    ).toThrow();
  });
});
