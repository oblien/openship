"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useI18n } from "@/components/i18n-provider";

type AccessCopy = ReturnType<typeof useI18n>["t"]["misc"]["mcpAuthorize"] &
  Pick<ReturnType<typeof useI18n>["t"]["settings"]["mcp"], "editScopeTitle" | "editScopeSubtitle">;
const Context = createContext<Partial<AccessCopy> | undefined>(undefined);

/** Presentation only: every surface keeps the same editor, grants and authorization checks. */
export function AccessCopyProvider({
  value,
  children,
}: {
  value?: Partial<AccessCopy>;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccessCopy(): AccessCopy {
  const { t } = useI18n();
  const overrides = useContext(Context);
  return useMemo(
    () => ({
      ...t.misc.mcpAuthorize,
      editScopeTitle: t.settings.mcp.editScopeTitle,
      editScopeSubtitle: t.settings.mcp.editScopeSubtitle,
      ...overrides,
    }),
    [
      t.misc.mcpAuthorize,
      t.settings.mcp.editScopeTitle,
      t.settings.mcp.editScopeSubtitle,
      overrides,
    ],
  );
}

export const ASSISTANT_ACCESS_COPY: Partial<AccessCopy> = {
  title: "Enable assistant",
  editScopeTitle: "Assistant permissions",
  editScopeSubtitle:
    "Review your current access. After saving changes, Continue in new chat keeps your last request ready to send.",
  subtitle: "Choose what your assistant can access before connecting an agent.",
  orgScopeNote: "Your assistant can act only within this workspace.",
  templatesHeading: "Choose what your assistant can do",
  tplAgentTitle: "Create & deploy",
  createProjectsDesc:
    "Your assistant can create projects and fully manage the ones it creates, including deleting them. It can't see projects it didn't create.",
  advancedNote: "These permissions apply to the connection, but do not add tools to the assistant.",
  summaryHeading: "Your assistant's permissions",
  summaryUnscopedBody:
    "Your assistant acts with your own role across this workspace. Only grant this to an agent you fully trust.",
  summaryReadOnlyBody: "Your assistant can read anything you can read, and write nothing.",
  readOnlySecretsNote:
    "Read-only still exposes secrets your assistant can reach, including environment variable values and connection strings.",
  missingClientId:
    "This permission request is invalid. Close it and try enabling the assistant again.",
  signInRequiredBody:
    "We couldn't confirm your session. Close this dialog and sign in again to enable the assistant.",
  authorizeError:
    "Couldn't enable the assistant. Try again, or close this dialog and start a new request.",
  deny: "Cancel",
  authorize: "Enable assistant",
};

export const CHAT_ACCESS_COPY: Partial<AccessCopy> = {
  ...ASSISTANT_ACCESS_COPY,
  title: "Link your chat account",
  subtitle:
    "Choose what you can control from chat. These permissions apply only to your linked account.",
  orgScopeNote: "Chat commands can act only within this workspace.",
  templatesHeading: "Choose your chat permissions",
  tplExistingDesc: "Check deployments, redeploy and restart the projects you pick.",
  editScopeTitle: "Chat permissions",
  editScopeSubtitle: "Changes apply to your linked chat account's next command.",
  createProjectsDesc:
    "Grants access to projects created by this connection. The current chat commands do not create projects.",
  summaryHeading: "Your chat permissions",
  summaryUnscopedBody: "Commands act with your own role across this workspace.",
  summaryReadOnlyBody:
    "Commands can read accessible project status, but cannot redeploy or restart.",
  advancedNote:
    "The connector supports only its documented commands, regardless of broader grants.",
  readOnlySecretsNote:
    "This read-only grant includes data your account can access. Chat commands return project status and private links; raw logs and secrets are not posted.",
  missingClientId: "This request is invalid. Send /openship link to start again.",
  signInRequiredBody: "Sign into OpenShip, then open the link from your chat again.",
  authorizeError: "Couldn't link your account. Try again, or send /openship link to start again.",
  authorize: "Link my account",
};
