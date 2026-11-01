// The composer and Novel must share the same ProseMirror instances.
export const editorSharedPackages = [
  "prosemirror-model",
  "prosemirror-state",
  "prosemirror-view",
] as const;
