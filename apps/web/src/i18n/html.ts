import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { Copy } from "./copy";

/** Translate release prose as text nodes. Code, attributes and URLs retain their source values. */
export function translateHtml(html: string, copy: Copy): string {
  const fragment = parseFragment(html);
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node && ["code", "pre", "script", "style"].includes(node.tagName)) return;
    if (node.nodeName === "#text" && "value" in node) node.value = copy(node.value);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(fragment);
  return serialize(fragment);
}
