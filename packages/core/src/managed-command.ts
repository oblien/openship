/** Recovery identity only. Command text, credentials and output are never stored. */
export interface ManagedCommandRef {
  workspaceId: string;
  marker: string;
  taskId?: string;
  kind?: "terminal" | "docker";
  terminalId?: string;
}
