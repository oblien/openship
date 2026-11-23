import type { Nodes, Root } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx";

function textContent(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  return "children" in node ? node.children.map(textContent).join(" ") : "";
}

/** Index the card's visible copy, rather than exposing JSX props in search results. */
export function remarkSearchCards() {
  return (tree: Root) => {
    function visit(node: Nodes) {
      if (node.type === "mdxJsxFlowElement" && node.name === "Card") {
        const card = node as MdxJsxFlowElement;
        const content = ["title", "description"].map((name) => {
          const attribute = card.attributes.find(
            (value) => value.type === "mdxJsxAttribute" && value.name === name,
          );
          return attribute?.type === "mdxJsxAttribute" && typeof attribute.value === "string"
            ? attribute.value
            : "";
        });
        content.push(textContent(card));
        card.data = {
          ...card.data,
          structuredData: {
            contents: [{ heading: undefined, content: content.filter(Boolean).join(". ") }],
          },
        };
      }
      if ("children" in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}
