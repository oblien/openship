import * as vscode from "vscode";
import { Commands } from "./commands";
import { Connections } from "./connections";
import { errorMessage, UserCancelled } from "./errors";
import { Logs } from "./logs";
import { ProjectsTree } from "./projects-tree";

declare const __EXTENSION_VERSION__: string;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Openship");
  let tree: ProjectsTree | undefined;
  const logs = new Logs(output, (watching) => {
    void vscode.commands.executeCommand("setContext", "openship.watching", watching);
  });
  const connections = new Connections(
    context.globalState,
    context.secrets,
    () => {
      logs.stop();
      tree?.refresh();
    },
    undefined,
    __EXTENSION_VERSION__,
  );
  tree = new ProjectsTree(connections);
  const commands = new Commands(context, connections, tree, logs);
  context.subscriptions.push(
    logs,
    output,
    tree,
    vscode.window.createTreeView("openship.projects", {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    context.secrets.onDidChange(() => {
      logs.stop();
      tree?.refresh();
    }),
  );

  const handlers: Record<string, (arg?: unknown) => unknown> = {
    connect: () => commands.connect(),
    updateToken: (arg) => commands.updateToken(arg),
    removeConnection: (arg) => commands.removeConnection(arg),
    refresh: () => tree?.refresh(),
    linkWorkspace: (arg) => commands.linkWorkspace(arg),
    deploy: (arg) => commands.deploy(arg),
    watchDeployment: (arg) => commands.watchDeployment(arg),
    runtimeLogs: (arg) => commands.runtimeLogs(arg),
    stopLogs: () => commands.stopLogs(),
    cancelDeployment: (arg) => commands.cancelDeployment(arg),
    respondToDeployment: (arg) => commands.respondToDeployment(arg),
    openDashboard: (arg) => commands.openDashboard(arg),
    openApplication: (arg) => commands.openApplication(arg),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`openship.${name}`, async (arg?: unknown) => {
        try {
          return await handler(arg);
        } catch (error) {
          if (error instanceof UserCancelled) return;
          const message = errorMessage(error);
          output.appendLine(message);
          void vscode.window.showErrorMessage(`Openship: ${message}`);
        }
      }),
    );
  }
  void vscode.commands.executeCommand("setContext", "openship.watching", false);
}
