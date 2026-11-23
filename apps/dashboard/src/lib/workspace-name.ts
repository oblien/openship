import { authClient } from "./auth-client";

export const WORKSPACE_NAME_CHANGED = "openship:workspace-name-changed";

export type WorkspaceNameChange = { organizationId: string; name: string };

export async function renameWorkspace(organizationId: string, name: string) {
  const result = await authClient.organization.update({ organizationId, data: { name } });
  if (!result.error && result.data?.id === organizationId) {
    window.dispatchEvent(
      new CustomEvent<WorkspaceNameChange>(WORKSPACE_NAME_CHANGED, {
        detail: { organizationId, name: result.data.name },
      }),
    );
  }
  return result;
}
