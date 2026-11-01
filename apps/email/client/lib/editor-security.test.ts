import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { mergeAttributes } from "@tiptap/core";
import { DOMSerializer, Schema } from "prosemirror-model";

describe("composer editor dependency compatibility", () => {
  it("does not turn a JSON prototype key into executable inherited DOM attributes", async () => {
    const browser = new Window();
    try {
      const input = JSON.parse(
        '{"__proto__":{"src":"invalid-image","onerror":"globalThis.attachmentExecuted=true"}}',
      );
      const attributes = mergeAttributes({ class: "attachment" }, input);
      expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
      expect(attributes.onerror).toBeUndefined();
      const schema = new Schema({
        nodes: { doc: { content: "image" }, image: { toDOM: () => ["img", attributes] }, text: {} },
      });
      const content = schema.node("doc", null, [schema.node("image")]);
      const fragment = DOMSerializer.fromSchema(schema).serializeFragment(content.content, {
        document: browser.document as unknown as Document,
      });
      const image = fragment.firstChild as HTMLElement;
      expect(image.getAttribute("onerror")).toBeNull();
      expect(image.getAttribute("src")).toBeNull();
      expect(image.className).toBe("attachment");
    } finally {
      await browser.happyDOM.close();
    }
  });
});
