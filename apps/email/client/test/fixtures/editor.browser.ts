import { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { defaultExtensions } from "../../components/create/extensions";

Object.assign(window, {
  editorCheck: () => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: defaultExtensions,
      content: "<p>Release notes</p>",
    });
    try {
      editor.commands.selectAll();
      editor.commands.insertContent("Updated");
      if (editor.getText() !== "Updated") throw new Error("Composer edit failed");
      editor.commands.undo();
      if (editor.getText() !== "Release notes") throw new Error("Composer history failed");
      editor.commands.redo();
      editor.commands.selectAll();
      editor.commands.setBold();
      if (!editor.getHTML().includes("<strong>Updated</strong>"))
        throw new Error("Composer mark serialization failed");
      editor.commands.setContent('<p><a href="javascript:alert(1)">Unsafe link</a></p><p>Safe</p>');
      if (editor.getHTML().includes("javascript:") || !editor.getText().includes("Safe"))
        throw new Error("Composer link validation failed");
    } finally {
      editor.destroy();
    }
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          group: "block",
          content: "text*",
          toDOM: () => ["p", 0],
          parseDOM: [{ tag: "p" }],
        },
        blockquote: {
          group: "block",
          content: "block+",
          attrs: { level: { default: 0, validate: "number" } },
          toDOM: (node) => ["blockquote", { "data-level": node.attrs.level }, 0],
        },
        text: {},
      },
    });
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema }),
      transformPasted: (slice) => {
        slice.content.descendants((node) => {
          if (node.type.name === "blockquote" && typeof node.attrs.level !== "number")
            throw new Error("Invalid clipboard context bypassed its attribute validator");
        });
        return slice;
      },
    });
    try {
      const context = JSON.stringify(["blockquote", { level: { unexpected: true } }]).replaceAll(
        '"',
        "&quot;",
      );
      view.pasteHTML(`<p data-pm-slice="0 0 ${context}">Pasted text</p>`);
      if (view.state.doc.textContent !== "Pasted text")
        throw new Error("Valid pasted content was lost");
      view.state.doc.descendants((node) => {
        if (node.type.name === "blockquote" && typeof node.attrs.level !== "number")
          throw new Error("Invalid clipboard context bypassed its attribute validator");
      });
    } finally {
      view.destroy();
    }
  },
});
