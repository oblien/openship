import type { ToolResultView } from "./tool-presentation";

export interface ToolPreview {
  index: string;
  view: ToolResultView;
  itemCalls?: Map<string, string>;
}

/** Share one flow collection, preserving each distinct saved ID and every call in the inspector. */
export function combineToolPreviews(input: ToolPreview[]): ToolPreview[] {
  const previews: ToolPreview[] = [];
  let automations: ToolPreview | undefined;
  for (const preview of [...input].sort((a, b) => Number(a.index) - Number(b.index))) {
    if (preview.view.kind !== "automations") {
      previews.push(preview);
      continue;
    }
    if (!automations) {
      automations = { ...preview, view: { ...preview.view, items: [] }, itemCalls: new Map() };
      previews.push(automations);
    }
    const items = new Map(automations.view.items.map((item) => [item.id, item]));
    for (const item of preview.view.items) {
      const previous = items.get(item.id);
      items.set(item.id, item.automation || !previous?.automation ? item : previous);
      automations.itemCalls!.set(item.id, preview.index);
    }
    automations.index = preview.index;
    automations.view = { ...automations.view, items: [...items.values()], total: items.size };
  }
  return previews;
}
