import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySourceText } from "./sdk-relocation-compare.mjs";

const classify = (before, after) =>
  classifySourceText(
    "apps/api/src/lib/example.ts",
    Buffer.from(before),
    "packages/platform/src/engine/lib/example.ts",
    Buffer.from(after),
  );

test("byte equality retains every byte, including BOM and CRLF", () => {
  const source = '\uFEFFimport { value } from "./other";\r\nexport const answer = value;\r\n';
  assert.equal(classify(source, source), "byte-identical");
  assert.equal(classify(source, source.replaceAll("\r\n", "\n")), "other-text-changes");
});

test("only actual module strings are exempted, including type imports", () => {
  const before = [
    'import { value } from "./other";',
    'export { helper } from "./helper";',
    'const lazy = import("./lazy");',
    'const legacy = require("./legacy");',
    'type Options = import("./types").Options;',
  ].join("\n");
  const after = before.replaceAll('"./', '"@repo/platform/engine/lib/');
  assert.equal(classify(before, after), "module-specifiers-only");
});

for (const [description, before, after] of [
  [
    "an omitted branch",
    'export function access(ok) { if (!ok) throw Error("denied"); return 1; }',
    "export function access(ok) { return 1; }",
  ],
  ["ordinary string data", 'const path = "./old";', 'const path = "./new";'],
  ["import bindings", 'import { before } from "./old";', 'import { after } from "./new";'],
  [
    "import declaration order",
    'import "./a";\nimport { x } from "./b";',
    'import { x } from "./b";\nimport "./a";',
  ],
  ["comments", '// before\nimport { x } from "./old";', '// after\nimport { x } from "./new";'],
  [
    "types",
    'import { x } from "./old";\nconst y: string = x;',
    'import { x } from "./new";\nconst y: number = x;',
  ],
  ["formatting", 'import { x } from "./old";', 'import {x} from "./new";'],
  ["quote style", 'import { x } from "./old";', "import { x } from './new';"],
  [
    "computed import expressions",
    'const x = import("./old" + suffix);',
    'const x = import("./new" + suffix);',
  ],
  ["invalid syntax", 'import { x } from "./old";\nconst =', 'import { x } from "./new";\nconst ='],
]) {
  test("does not conceal " + description, () => {
    assert.equal(classify(before, after), "other-text-changes");
  });
}

test("invalid UTF-8 cannot become equal through replacement-character decoding", () => {
  assert.equal(
    classifySourceText("before.ts", Buffer.from([0xff]), "after.ts", Buffer.from([0xfe])),
    "other-text-changes",
  );
});
