import * as vscode from "vscode";
import type { DeploymentOutcome } from "@repo/sdk/client";
import type { Connections } from "./connections";
import { cleanText, errorMessage, UserCancelled } from "./errors";
import type { Logs } from "./logs";
import {
  type Connection,
  type DeploymentReference,
  type ProjectReference,
  type ProjectTarget,
  isDeploymentReference,
  isProjectReference,
  isRecord,
  projectLabel,
} from "./model";
import type { ProjectsTree } from "./projects-tree";
import { assertGitProject, listProjects, resolveDeployment, resolveProject } from "./targets";
import { applicationUrl, dashboardUrl, endpointError, normalizeEndpoint } from "./urls";
import {
  assertRemoteLink,
  linkPath,
  matchingBinding,
  readLinkText,
  readNearestLink,
  writeProjectLink,
  type LoadedLink,
  type WorkspaceBinding,
} from "./workspace-link";

const bindingKey = (folder: vscode.WorkspaceFolder) => `openship.link.${folder.uri.toString()}`;

export function requireTrust(): void {
  if (!vscode.workspace.isTrusted)
    throw new Error("Trust this workspace in VS Code before linking it or changing a deployment.");
}

function chosen<T>(value: T | undefined): T {
  if (value === undefined) throw new UserCancelled();
  return value;
}

export class Commands {
  private readonly deploying = new Set<string>();
  private logRequest = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: Connections,
    private readonly tree: ProjectsTree,
    private readonly logs: Logs,
  ) {}

  async connect(): Promise<Connection> {
    const name = chosen(
      await vscode.window.showInputBox({
        title: "Openship: Connect (1/5)",
        prompt: "Connection name",
        placeHolder: "production",
        ignoreFocusOut: true,
        validateInput: (value) =>
          !value.trim()
            ? "Enter a name."
            : this.connections.list().some((item) => item.name === value.trim())
              ? "That connection name is already in use."
              : undefined,
      }),
    );
    const apiUrl = normalizeEndpoint(
      chosen(
        await vscode.window.showInputBox({
          title: "Openship: Connect (2/5)",
          prompt: "Openship API URL",
          placeHolder: "https://ship.example.com",
          ignoreFocusOut: true,
          validateInput: endpointError,
        }),
      ),
    );
    const dashboard = normalizeEndpoint(
      chosen(
        await vscode.window.showInputBox({
          title: "Openship: Connect (3/5)",
          prompt: "Dashboard URL (may differ from the API URL)",
          value: apiUrl.replace(/\/api$/, ""),
          ignoreFocusOut: true,
          validateInput: endpointError,
        }),
      ),
    );
    const organizationId =
      chosen(
        await vscode.window.showInputBox({
          title: "Openship: Connect (4/5)",
          prompt:
            "Organization ID (optional). Leave blank to use the token's default organization.",
          ignoreFocusOut: true,
        }),
      ).trim() || undefined;
    const token = await this.enterToken("Openship: Connect (5/5)");
    const connection = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to Openship…" },
      () => this.connections.add({ name, apiUrl, dashboardUrl: dashboard, organizationId }, token),
    );
    void vscode.window.showInformationMessage(`Connected to Openship: ${connection.name}.`);
    return connection;
  }

  private async enterToken(title = "Openship: Update Access Token"): Promise<string> {
    return chosen(
      await vscode.window.showInputBox({
        title,
        password: true,
        ignoreFocusOut: true,
        prompt:
          "Personal access token with project read access. Create one in your dashboard's Settings.",
        validateInput: (value) =>
          /^opsh_pat_\S+$/.test(value.trim())
            ? undefined
            : "Enter a personal access token starting with opsh_pat_.",
      }),
    );
  }

  private async pickConnection(
    arg?: unknown,
    alwaysAsk = false,
    title = "Select an Openship connection",
  ): Promise<Connection> {
    if (isRecord(arg) && typeof arg.connectionId === "string")
      return this.connections.get(arg.connectionId);
    const connections = this.connections.list();
    if (!connections.length) return this.connect();
    if (connections.length === 1 && !alwaysAsk) return connections[0];
    return chosen(
      await vscode.window.showQuickPick(
        connections.map((connection) => ({
          label: connection.name,
          description: connection.apiUrl,
          detail: connection.organizationId
            ? `Organization: ${connection.organizationId}`
            : undefined,
          connection,
        })),
        { title, ignoreFocusOut: true },
      ),
    ).connection;
  }

  async updateToken(arg?: unknown): Promise<void> {
    const connection = await this.pickConnection(arg);
    const token = await this.enterToken();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking access token…" },
      () => this.connections.updateToken(connection.id, token),
    );
    void vscode.window.showInformationMessage(`Updated the access token for ${connection.name}.`);
  }

  async removeConnection(arg?: unknown): Promise<void> {
    const connection = await this.pickConnection(arg);
    const answer = await vscode.window.showWarningMessage(
      `Remove the saved connection "${connection.name}" and its access token?`,
      { modal: true },
      "Remove Connection",
    );
    if (answer !== "Remove Connection") return;
    await this.connections.remove(connection.id);
  }

  private async pickFolder(required: boolean): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      if (required) throw new Error("Open a folder in VS Code before linking a project.");
      return;
    }
    if (folders.length === 1) return folders[0];
    return chosen(
      await vscode.window.showQuickPick(
        folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { title: "Select the workspace folder", ignoreFocusOut: true },
      ),
    ).folder;
  }

  private async pickProject(arg?: unknown): Promise<ProjectTarget> {
    const connection = await this.pickConnection(arg);
    const projects = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Loading projects from ${connection.name}…`,
      },
      () => listProjects(this.connections, connection.id),
    );
    if (!projects.length)
      throw new Error(
        "No projects are available. Create or import a project in your Openship dashboard first.",
      );
    const { project } = chosen(
      await vscode.window.showQuickPick(
        projects.map((project) => ({
          label: cleanText(projectLabel(project)),
          description: cleanText(project.gitRepo || project.slug),
          detail: project.id,
          project,
        })),
        {
          title: `Select a project on ${connection.name}`,
          ignoreFocusOut: true,
          matchOnDescription: true,
        },
      ),
    );
    return resolveProject(this.connections, {
      connectionId: connection.id,
      projectId: project.id,
      organizationId: project.organizationId,
    });
  }

  private async saveBinding(
    folder: vscode.WorkspaceFolder,
    loaded: LoadedLink,
    target: ProjectReference,
  ): Promise<void> {
    const binding: WorkspaceBinding = {
      path: loaded.path,
      fingerprint: loaded.fingerprint,
      connectionId: target.connectionId,
      projectId: target.projectId,
      organizationId: target.organizationId,
    };
    await this.context.workspaceState.update(bindingKey(folder), binding);
  }

  private async project(arg?: unknown): Promise<ProjectTarget> {
    if (isProjectReference(arg)) return resolveProject(this.connections, arg);
    const folder = await this.pickFolder(false);
    // Restricted workspaces can browse remote resources without reading a
    // repository's link file or using it to choose credentials.
    const loaded =
      folder && vscode.workspace.isTrusted ? await readNearestLink(folder.uri.fsPath) : undefined;
    if (!folder || !loaded) return this.pickProject(arg);
    assertRemoteLink(loaded.link);
    const binding = matchingBinding(this.context.workspaceState.get(bindingKey(folder)), loaded);
    let target: ProjectTarget;
    if (binding) target = await resolveProject(this.connections, binding);
    else {
      const connection = await this.pickConnection(
        undefined,
        true,
        `Select the connection for ${folder.name}${loaded.link.context ? ` (CLI context: ${loaded.link.context})` : ""}`,
      );
      target = await resolveProject(this.connections, {
        connectionId: connection.id,
        projectId: loaded.link.projectId,
      });
      await this.saveBinding(folder, loaded, target);
    }
    return { ...target, branch: loaded.link.branch };
  }

  async linkWorkspace(arg?: unknown): Promise<void> {
    requireTrust();
    const folder = chosen(await this.pickFolder(true));
    const previous = await readLinkText(linkPath(folder.uri.fsPath));
    const target = isProjectReference(arg)
      ? await resolveProject(this.connections, arg)
      : await this.pickProject(arg);
    if (previous !== null) {
      const answer = await vscode.window.showWarningMessage(
        `Replace ${folder.name}'s project link with ${projectLabel(target.project)} on ${target.connection.name}?`,
        { modal: true },
        "Replace Link",
      );
      if (answer !== "Replace Link") return;
    }
    requireTrust();
    const loaded = await writeProjectLink(
      folder.uri.fsPath,
      {
        projectId: target.project.id,
        name: target.project.name,
        slug: target.project.slug,
        ...(target.project.gitBranch ? { branch: target.project.gitBranch } : {}),
        context: target.connection.name,
      },
      previous,
    );
    await this.saveBinding(folder, loaded, target);
    void vscode.window.showInformationMessage(
      `Linked ${folder.name} to ${projectLabel(target.project)} on ${target.connection.name}.`,
    );
  }

  async deploy(arg?: unknown): Promise<void> {
    requireTrust();
    const target = await this.project(arg);
    assertGitProject(target.project);
    const key = JSON.stringify([target.connectionId, target.organizationId, target.projectId]);
    if (this.deploying.has(key))
      throw new Error("A deployment request for this project is already in progress.");
    this.deploying.add(key);
    let holdsRequest = true;
    try {
      const branch = chosen(
        await vscode.window.showInputBox({
          title: "Openship: Deploy Git Branch",
          ignoreFocusOut: true,
          prompt: "Remote Git branch. Push your local commits before deploying.",
          value: target.branch || target.project.gitBranch || "main",
          validateInput: (value) =>
            !value.trim() || /[\x00-\x20]/.test(value.trim())
              ? "Enter a Git branch without spaces or control characters."
              : undefined,
        }),
      ).trim();
      const choices: Array<{
        label: string;
        description: string;
        value: "production" | "preview";
      }> = [
        {
          label: "Production variables",
          description: "Use this project's production variable set",
          value: "production",
        },
      ];
      if (target.project.environmentType && target.project.environmentType !== "production") {
        choices.push({
          label: "Preview variables",
          description: "Use this project's preview variable set",
          value: "preview",
        });
      }
      const environment =
        choices.length === 1
          ? "production"
          : chosen(
              await vscode.window.showQuickPick(choices, {
                title: `Variable set for ${projectLabel(target.project)}`,
                ignoreFocusOut: true,
              }),
            ).value;
      const answer = await vscode.window.showInformationMessage(
        `Deploy remote branch "${branch}" to ${projectLabel(target.project)}?`,
        {
          modal: true,
          detail: `Connection: ${target.connection.name}\nAPI: ${target.connection.apiUrl}\nProject: ${target.projectId}\nVariables: ${environment}`,
        },
        "Deploy",
      );
      if (answer !== "Deploy") return;
      requireTrust();
      const fresh = await resolveProject(this.connections, target);
      assertGitProject(fresh.project);
      let result;
      try {
        result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Starting Openship deployment…",
          },
          () =>
            fresh.client.deployments.create({ projectId: fresh.projectId, branch, environment }),
        );
      } catch (error) {
        this.tree.refresh();
        throw new Error(
          `${errorMessage(error)} Refresh deployment history before retrying if the request may have reached the server.`,
        );
      }
      if (result.project_id !== fresh.projectId)
        throw new Error(
          "The API returned a deployment for another project. Check the dashboard before continuing.",
        );
      this.tree.refresh();
      this.deploying.delete(key);
      holdsRequest = false;
      await this.watchDeployment({
        connectionId: fresh.connectionId,
        organizationId: fresh.organizationId,
        projectId: fresh.projectId,
        deploymentId: result.deployment_id,
      });
    } finally {
      if (holdsRequest) this.deploying.delete(key);
    }
  }

  private async deployment(arg?: unknown): Promise<DeploymentReference> {
    if (isDeploymentReference(arg))
      return {
        connectionId: arg.connectionId,
        projectId: arg.projectId,
        organizationId: arg.organizationId,
        deploymentId: arg.deploymentId,
      };
    if (arg === undefined && this.logs.currentDeployment) return this.logs.currentDeployment;
    const target = await this.project(arg);
    const page = await target.client.deployments.list({ projectId: target.projectId, perPage: 50 });
    if (!page.data.length) throw new Error("This project has no deployments yet.");
    const { deployment } = chosen(
      await vscode.window.showQuickPick(
        page.data.map((deployment) => ({
          label: cleanText(`${deployment.branch} · ${deployment.id.slice(0, 8)}`),
          description: deployment.status,
          detail: cleanText(`${deployment.createdAt} ${deployment.commitMessage || ""}`),
          deployment,
        })),
        { title: `Select a deployment of ${projectLabel(target.project)}`, ignoreFocusOut: true },
      ),
    );
    return {
      connectionId: target.connectionId,
      projectId: target.projectId,
      organizationId: target.organizationId,
      deploymentId: deployment.id,
    };
  }

  async watchDeployment(arg?: unknown): Promise<void> {
    const request = ++this.logRequest;
    const ref = await this.deployment(arg);
    const target = await resolveDeployment(this.connections, ref);
    if (request !== this.logRequest) return;
    const outcome = await this.logs.deployment(
      target.client,
      ref,
      `${target.connection.name} / ${projectLabel(target.project)} / ${target.deployment.id}`,
    );
    this.tree.refresh();
    if (outcome && request === this.logRequest) await this.showOutcome(outcome, ref);
  }

  private async showOutcome(outcome: DeploymentOutcome, ref: DeploymentReference): Promise<void> {
    if (outcome.prompt) {
      const answer = await vscode.window.showWarningMessage(
        cleanText(`Deployment needs a decision: ${outcome.prompt.title}`),
        "Respond",
        "Open Dashboard",
      );
      if (answer === "Respond") await this.respondToDeployment(ref);
      else if (answer === "Open Dashboard") await this.openDashboard(ref);
    } else if (outcome.decisionPending || outcome.status === "action_required") {
      const answer = await vscode.window.showWarningMessage(
        "Deployment needs a decision in Openship.",
        "Open Dashboard",
      );
      if (answer === "Open Dashboard") await this.openDashboard(ref);
    } else if (outcome.success) {
      const answer = await vscode.window.showInformationMessage(
        outcome.status === "no_changes"
          ? "Deployment finished: no changes."
          : "Deployment is ready.",
        "Open Application",
      );
      if (answer === "Open Application") await this.openApplication(ref);
    } else if (outcome.status === "cancelled") {
      void vscode.window.showInformationMessage("Deployment cancelled.");
    } else {
      void vscode.window.showWarningMessage(
        cleanText(
          `Deployment ${outcome.status}. ${outcome.message || "See the Openship output for details."}`,
        ),
      );
    }
  }

  async runtimeLogs(arg?: unknown): Promise<void> {
    const request = ++this.logRequest;
    const target = await this.project(arg);
    if (request !== this.logRequest) return;
    await this.logs.runtime(
      target.client,
      target.projectId,
      `Application logs: ${target.connection.name} / ${projectLabel(target.project)}`,
    );
  }

  stopLogs(): void {
    this.logRequest++;
    this.logs.stop();
  }

  async cancelDeployment(arg?: unknown): Promise<void> {
    requireTrust();
    const ref = await this.deployment(arg);
    const target = await resolveDeployment(this.connections, ref);
    const answer = await vscode.window.showWarningMessage(
      `Cancel deployment ${target.deploymentId.slice(0, 8)} of ${projectLabel(target.project)} on ${target.connection.name}?`,
      { modal: true },
      "Cancel Deployment",
    );
    if (answer !== "Cancel Deployment") return;
    requireTrust();
    const result = await target.client.deployments.cancel(target.deploymentId);
    this.tree.refresh();
    if (!result.success) throw new Error(result.message);
    void vscode.window.showInformationMessage(
      cleanText(
        result.message || (result.pending ? "Cancellation requested." : "Deployment cancelled."),
      ),
    );
  }

  async respondToDeployment(arg?: unknown): Promise<void> {
    requireTrust();
    const ref = await this.deployment(arg);
    const target = await resolveDeployment(this.connections, ref);
    const status = await target.client.deployments.buildStatus(target.deploymentId);
    const prompt = status.pendingPrompt;
    if (!prompt) {
      const answer = await vscode.window.showInformationMessage(
        "No interactive prompt is available. Check the dashboard for pending deployment decisions.",
        "Open Dashboard",
      );
      if (answer === "Open Dashboard") await this.openDashboard(ref);
      return;
    }
    const action = chosen(
      await vscode.window.showQuickPick(
        prompt.actions.map((action) => ({ label: cleanText(action.label), action: action.id })),
        {
          title: cleanText(prompt.title),
          placeHolder: cleanText(prompt.message),
          ignoreFocusOut: true,
        },
      ),
    ).action;
    requireTrust();
    const current = (await target.client.deployments.buildStatus(target.deploymentId))
      .pendingPrompt;
    if (
      !current ||
      current.promptId !== prompt.promptId ||
      current.expiresAt !== prompt.expiresAt ||
      !current.actions.some((choice) => choice.id === action)
    ) {
      throw new Error(
        "That deployment prompt changed or expired. Refresh and respond to the current prompt.",
      );
    }
    const result = await target.client.deployments.respond(target.deploymentId, { action });
    if (!result.success)
      throw new Error("The prompt expired or was already answered. Refresh the deployment.");
    await this.watchDeployment(ref);
  }

  async openDashboard(arg?: unknown): Promise<void> {
    const connection = await this.pickConnection(arg);
    const url = dashboardUrl(
      connection.dashboardUrl,
      isProjectReference(arg) ? arg.projectId : undefined,
      isDeploymentReference(arg) ? arg.deploymentId : undefined,
    );
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  async openApplication(arg?: unknown): Promise<void> {
    let url: string | null;
    if (isDeploymentReference(arg))
      url = (await resolveDeployment(this.connections, arg)).deployment.url;
    else {
      const target = await this.project(arg);
      if (!target.project.activeDeploymentId)
        throw new Error("This project has no active deployment yet.");
      url = (
        await resolveDeployment(this.connections, {
          ...target,
          deploymentId: target.project.activeDeploymentId,
        })
      ).deployment.url;
    }
    if (!url) throw new Error("This deployment has no public application URL.");
    await vscode.env.openExternal(vscode.Uri.parse(applicationUrl(url), true));
  }
}
