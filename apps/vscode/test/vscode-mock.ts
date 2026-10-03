import { vi } from "vitest";

export const ProgressLocation = { Notification: 15 };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem {
  constructor(
    public label: string,
    public collapsibleState = 0,
  ) {}
}
export class ThemeIcon {
  constructor(public id: string) {}
}
export class EventEmitter {
  event = vi.fn();
  fire = vi.fn();
  dispose = vi.fn();
}
export const Uri = { parse: (url: string) => new URL(url) };
export const window = {
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn(async (_options: unknown, work: () => Promise<unknown>) => work()),
};
export const env = { openExternal: vi.fn(async (_uri: { toString(): string }) => true) };
export const workspace = { isTrusted: true, workspaceFolders: [] as unknown[] };

export function resetUI() {
  for (const method of Object.values(window)) method.mockClear();
  for (const method of [
    window.showInputBox,
    window.showQuickPick,
    window.showInformationMessage,
    window.showWarningMessage,
    window.showErrorMessage,
  ])
    method.mockReset();
  env.openExternal.mockClear();
  workspace.isTrusted = true;
  workspace.workspaceFolders = [];
}
