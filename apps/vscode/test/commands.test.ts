import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { Commands } from "../src/commands";
import type { Logs } from "../src/logs";
import type { ProjectsTree } from "../src/projects-tree";
import { writeProjectLink } from "../src/workspace-link";
import {
  buildStatus,
  connectionInput,
  deployment,
  memoryState,
  page,
  project,
  setupConnections,
  token,
} from "./helpers";
import { env, resetUI, window, workspace } from "./vscode-mock";

const directories: string[] = [];
beforeEach(resetUI);
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function setup() {
  const test = setupConnections();
  const connection = await test.connections.add(connectionInput, token);
  const state = memoryState();
  const logs = {
    deployment: vi.fn(async () => undefined),
    runtime: vi.fn(async () => undefined),
    stop: vi.fn(),
    currentDeployment: undefined,
  };
  const refresh = vi.fn();
  const commands = new Commands(
    { workspaceState: state.state } as ExtensionContext,
    test.connections,
    { refresh } as unknown as ProjectsTree,
    logs as unknown as Logs,
  );
  const ref = {
    connectionId: connection.id,
    organizationId: project.organizationId,
    projectId: project.id,
    deploymentId: deployment.id,
  };
  return { ...test, connection, commands, logs, ref, refresh, workspaceState: state };
}

async function folder(name: string, path?: string) {
  const directory = path ?? (await mkdtemp(join(tmpdir(), "openship-vscode-command-")));
  if (!path) directories.push(directory);
  await mkdir(directory, { recursive: true });
  return {
    name,
    index: 0,
    uri: { fsPath: directory, toString: () => pathToFileURL(directory).href },
  };
}

describe("editor deployment workflows", () => {
  it.each(["new selection", "stop"])("ignores a delayed log request after %s", async (action) => {
    const test = await setup();
    const previous = test.fetch.getMockImplementation()!;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let projectRequests = 0;
    test.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/projects/${project.id}`) && ++projectRequests === 1)
        return pending;
      return previous(input, init);
    });
    const first = test.commands.runtimeLogs(test.ref);
    await vi.waitFor(() => expect(projectRequests).toBe(1));
    if (action === "stop") test.commands.stopLogs();
    else await test.commands.runtimeLogs(test.ref);
    release(Response.json({ data: project }));
    await first;
    expect(test.logs.runtime).toHaveBeenCalledTimes(action === "stop" ? 0 : 1);
  });

  it("blocks mutating commands in an untrusted workspace before any API call", async () => {
    const test = await setup();
    workspace.isTrusted = false;
    test.fetch.mockClear();
    for (const run of [
      () => test.commands.deploy(test.ref),
      () => test.commands.linkWorkspace(test.ref),
      () => test.commands.cancelDeployment(test.ref),
      () => test.commands.respondToDeployment(test.ref),
    ]) {
      await expect(run()).rejects.toThrow("Trust this workspace");
    }
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("uses the selected remote branch, project, and organization for a single deployment request", async () => {
    const test = await setup();
    test.fetch.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/health"))
        return Response.json({ sdk: { protocol: 1, fixedOrganizationScope: true } });
      if (path.endsWith(`/projects/${project.id}`)) return Response.json({ data: project });
      if (path.endsWith("/deployments") && init?.method === "POST")
        return Response.json({ data: { deployment_id: deployment.id, project_id: project.id } });
      if (path.endsWith(`/deployments/${deployment.id}`))
        return Response.json({ data: deployment });
      throw new Error(`Unexpected request ${path}`);
    });
    window.showInputBox.mockResolvedValue("feature/editor");
    window.showInformationMessage.mockResolvedValue("Deploy");
    await test.commands.deploy(test.ref);
    const posts = test.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]?.body as string)).toEqual({
      projectId: project.id,
      branch: "feature/editor",
      environment: "production",
    });
    expect(new Headers(posts[0][1]?.headers).get("X-Organization-Id")).toBe(project.organizationId);
    expect(test.logs.deployment).toHaveBeenCalledOnce();
  });

  it("does not deploy when the target confirmation is dismissed", async () => {
    const test = await setup();
    window.showInputBox.mockResolvedValue("main");
    window.showInformationMessage.mockResolvedValue(undefined);
    await test.commands.deploy(test.ref);
    expect(test.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("requires an explicit connection when importing a CLI link and refuses a removed binding", async () => {
    const test = await setup();
    const selected = await folder("web");
    workspace.workspaceFolders = [selected];
    await writeProjectLink(
      selected.uri.fsPath,
      { projectId: project.id, context: "production" },
      null,
    );
    window.showQuickPick.mockResolvedValue({ connection: test.connection });
    await test.commands.runtimeLogs();
    expect(window.showQuickPick).toHaveBeenCalledOnce();
    window.showQuickPick.mockClear();
    await test.commands.runtimeLogs();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    await test.connections.remove(test.connection.id);
    await test.connections.add({ ...connectionInput, name: "replacement" }, token);
    await expect(test.commands.runtimeLogs()).rejects.toThrow("no longer available");
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("links only the selected folder in a workspace with multiple roots", async () => {
    const test = await setup();
    const one = await folder("one");
    const two = await folder("two");
    workspace.workspaceFolders = [one, two];
    window.showQuickPick.mockResolvedValue({ folder: two });
    await test.commands.linkWorkspace(test.ref);
    expect([...test.workspaceState.values.keys()]).toEqual([`openship.link.${two.uri.toString()}`]);
  });

  it("never loads a native project through an HTTP connection", async () => {
    const test = await setup();
    const selected = await folder("native");
    workspace.workspaceFolders = [selected];
    await writeProjectLink(
      selected.uri.fsPath,
      { projectId: project.id, native: { instanceId: "native-one", organizationId: "org-a" } },
      null,
    );
    test.fetch.mockClear();
    await expect(test.commands.runtimeLogs()).rejects.toThrow("native Openship instance");
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("does not claim that a pending cancellation already finished", async () => {
    const test = await setup();
    const previous = test.fetch.getMockImplementation()!;
    test.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/cancel"))
        return Response.json({
          success: true,
          pending: true,
          status: "cancelling",
          message: "Cancellation requested.",
        });
      return previous(input, init);
    });
    window.showWarningMessage.mockResolvedValue("Cancel Deployment");
    await test.commands.cancelDeployment(test.ref);
    expect(window.showInformationMessage).toHaveBeenCalledWith("Cancellation requested.");
  });

  it("does not submit a response after a deployment prompt changes", async () => {
    const test = await setup();
    const previous = test.fetch.getMockImplementation()!;
    let polls = 0;
    test.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/build"))
        return Response.json(
          buildStatus("action_required", {
            pendingPrompt: {
              promptId: ++polls === 1 ? "first" : "replacement",
              title: "Port conflict",
              message: "Choose an action",
              actions: [{ id: "takeover", label: "Take over" }],
            },
          }),
        );
      return previous(input, init);
    });
    window.showQuickPick.mockResolvedValue({ action: "takeover" });
    await expect(test.commands.respondToDeployment(test.ref)).rejects.toThrow("changed or expired");
    expect(test.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("rejects application command URIs and preserves dashboard proxy prefixes", async () => {
    const test = await setup();
    const previous = test.fetch.getMockImplementation()!;
    test.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/deployments/${deployment.id}`))
        return Response.json({
          data: { ...deployment, url: "command:workbench.action.closeWindow" },
        });
      return previous(input, init);
    });
    await expect(test.commands.openApplication(test.ref)).rejects.toThrow("HTTP or HTTPS");
    expect(env.openExternal).not.toHaveBeenCalled();
    await test.commands.openDashboard(test.ref);
    expect(env.openExternal.mock.calls[0]?.[0]?.toString()).toBe(
      `https://dashboard.example.com/build/${deployment.id}`,
    );
  });
});
