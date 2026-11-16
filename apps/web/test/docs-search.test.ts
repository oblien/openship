import { expect, test } from "bun:test";
import type { Root } from "mdast";
import { remarkSearchCards } from "../src/lib/docs-search";

test("search keeps visible card text without indexing links, icons, or JSX expressions", () => {
  const card = {
    type: "mdxJsxFlowElement" as const,
    name: "Card",
    attributes: [
      { type: "mdxJsxAttribute" as const, name: "title", value: "Restore a backup" },
      { type: "mdxJsxAttribute" as const, name: "description", value: "Recover application data" },
      { type: "mdxJsxAttribute" as const, name: "href", value: "/docs/guides/backups-restore" },
      {
        type: "mdxJsxAttribute" as const,
        name: "icon",
        value: { type: "mdxJsxAttributeValueExpression" as const, value: "<Database />" },
      },
    ],
    children: [
      {
        type: "paragraph" as const,
        children: [{ type: "text" as const, value: "Verify the restored service." }],
      },
    ],
    data: {},
  };
  const paragraph = {
    type: "paragraph" as const,
    children: [{ type: "text" as const, value: "Other guide content" }],
  };
  const tree: Root = { type: "root", children: [card, paragraph] };
  remarkSearchCards()(tree);
  expect(card.data).toEqual({
    structuredData: {
      contents: [
        {
          heading: undefined,
          content: "Restore a backup. Recover application data. Verify the restored service.",
        },
      ],
    },
  });
  expect(tree.children[1]).toEqual(paragraph);
});

test("search does not evaluate dynamic props or turn layout containers into results", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "mdxJsxFlowElement",
        name: "Cards",
        attributes: [],
        children: [
          {
            type: "mdxJsxFlowElement",
            name: "Card",
            attributes: [
              {
                type: "mdxJsxAttribute",
                name: "title",
                value: { type: "mdxJsxAttributeValueExpression", value: "readPrivateValue()" },
              },
            ],
            children: [],
          },
        ],
      },
    ],
  };
  remarkSearchCards()(tree);
  expect(JSON.stringify(tree.children[0].data)).toBeUndefined();
  expect((tree.children[0] as { children: Array<{ data?: unknown }> }).children[0].data).toEqual({
    structuredData: { contents: [{ heading: undefined, content: "" }] },
  });
});
