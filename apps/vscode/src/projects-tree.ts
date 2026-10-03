import * as vscode from "vscode";
import type { Deployment, Project } from "@repo/sdk/client";
import type { Connections } from "./connections";
import {
  type Connection,
  type DeploymentReference,
  type ProjectReference,
  projectLabel,
} from "./model";
import { listProjects } from "./targets";
import { cleanText, errorMessage } from "./errors";

export class ConnectionNode extends vscode.TreeItem {
  readonly connectionId: string;
  constructor(connection: Connection) {
    super(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.connectionId = connection.id;
    this.id = `connection:${connection.id}`;
    this.contextValue = "openship.connection";
    this.description = new URL(connection.apiUrl).host;
    this.tooltip = connection.apiUrl;
    this.iconPath = new vscode.ThemeIcon("remote");
  }
}

export class ProjectNode extends vscode.TreeItem implements ProjectReference {
  readonly projectId: string;
  readonly organizationId: string;
  constructor(
    readonly connectionId: string,
    project: Project,
  ) {
    super(cleanText(projectLabel(project)), vscode.TreeItemCollapsibleState.Collapsed);
    this.projectId = project.id;
    this.organizationId = project.organizationId;
    this.id = JSON.stringify([connectionId, project.organizationId, project.id]);
    this.contextValue = "openship.project";
    this.description = cleanText(project.gitBranch || project.framework || "");
    this.tooltip = `${project.id}\nOrganization: ${project.organizationId}`;
    this.iconPath = new vscode.ThemeIcon("project");
  }
}

export class DeploymentNode extends vscode.TreeItem implements DeploymentReference {
  readonly deploymentId: string;
  readonly projectId: string;
  readonly organizationId: string;
  constructor(
    readonly connectionId: string,
    deployment: Deployment,
  ) {
    super(
      cleanText(`${deployment.branch || "Deployment"} · ${deployment.id.slice(0, 8)}`),
      vscode.TreeItemCollapsibleState.None,
    );
    this.deploymentId = deployment.id;
    this.projectId = deployment.projectId;
    this.organizationId = deployment.organizationId;
    this.id = JSON.stringify([connectionId, deployment.projectId, deployment.id]);
    this.description = cleanText(deployment.status);
    this.tooltip = cleanText(
      `${deployment.status}\n${deployment.createdAt}\n${deployment.commitMessage || deployment.id}`,
    );
    this.contextValue = "openship.deployment";
    this.iconPath = new vscode.ThemeIcon(
      ["ready", "no_changes"].includes(deployment.status)
        ? "pass"
        : ["failed", "partial_failure", "rejected"].includes(deployment.status)
          ? "error"
          : deployment.status === "action_required"
            ? "warning"
            : deployment.status === "cancelled"
              ? "circle-slash"
              : "history",
    );
    this.command = {
      command: "openship.watchDeployment",
      title: "Watch Deployment",
      arguments: [this],
    };
  }
}

export type TreeNode = ConnectionNode | ProjectNode | DeploymentNode | vscode.TreeItem;

export class ProjectsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(private readonly connections: Connections) {}
  refresh(): void {
    this.changes.fire(undefined);
  }
  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!node) return this.connections.list().map((connection) => new ConnectionNode(connection));
      if (node instanceof ConnectionNode) {
        const projects = await listProjects(this.connections, node.connectionId);
        return projects.length
          ? projects.map((project) => new ProjectNode(node.connectionId, project))
          : [new vscode.TreeItem("No projects in this connection")];
      }
      if (node instanceof ProjectNode) {
        const page = await this.connections
          .client(node.connectionId, node.organizationId)
          .deployments.list({ projectId: node.projectId, perPage: 50 });
        const rows: TreeNode[] = page.data.map(
          (deployment) => new DeploymentNode(node.connectionId, deployment),
        );
        if (page.total > rows.length) {
          const more = new vscode.TreeItem(
            `Latest ${rows.length} of ${page.total} deployments — open dashboard for more`,
          );
          more.command = {
            command: "openship.openDashboard",
            title: "Open Dashboard",
            arguments: [node],
          };
          rows.push(more);
        }
        return rows.length ? rows : [new vscode.TreeItem("No deployments yet")];
      }
      return [];
    } catch (error) {
      const item = new vscode.TreeItem(errorMessage(error));
      item.iconPath = new vscode.ThemeIcon("warning");
      item.tooltip = "Use Refresh Projects to retry, or Update Access Token on the connection.";
      return [item];
    }
  }

  dispose(): void {
    this.changes.dispose();
  }
}
