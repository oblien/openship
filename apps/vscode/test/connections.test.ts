import { describe, expect, it } from "vitest";
import { ApiError } from "@repo/sdk/client";
import { connectionInput, deployment, page, project, setupConnections, token } from "./helpers";
import { listProjects, resolveDeployment, resolveProject } from "../src/targets";
import { errorMessage } from "../src/errors";

describe("connections and target identity", () => {
  it("loads all project pages from the selected connection", async () => {
    const projects = Array.from({ length: 101 }, (_, index) => ({
      ...project,
      id: `project-${index}`,
    }));
    const test = setupConnections(async (input) => {
      const url = new URL(String(input));
      const current = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("perPage") ?? 100);
      return Response.json(
        page(
          projects.slice((current - 1) * perPage, current * perPage),
          current,
          perPage,
          projects.length,
        ),
      );
    });
    const connection = await test.connections.add(connectionInput, token);
    expect(await listProjects(test.connections, connection.id)).toHaveLength(101);
    expect(
      test.fetch.mock.calls.some(([url]) => new URL(String(url)).searchParams.get("page") === "2"),
    ).toBe(true);
  });

  it("validates credentials, stores only metadata in state, and resolves tokens asynchronously", async () => {
    const test = setupConnections();
    const connection = await test.connections.add(connectionInput, token);
    expect(JSON.stringify([...test.state.values])).not.toContain(token);
    expect([...test.secrets.values.values()]).toEqual([token]);
    const target = await resolveProject(test.connections, {
      connectionId: connection.id,
      projectId: project.id,
    });
    await target.client.projects.get(project.id);
    expect(test.requests.at(-1)?.path).toBe("/proxy/api/projects/project-a");
    expect(test.requests.at(-1)?.headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(test.requests.at(-1)?.headers.get("X-Organization-Id")).toBe(project.organizationId);
  });

  it("does not persist rejected credentials or HTML returned by a dashboard URL", async () => {
    for (const response of [
      new Response("Unauthorized", { status: 401 }),
      new Response("<html>Dashboard</html>"),
    ]) {
      const test = setupConnections(async () => response);
      await expect(test.connections.add(connectionInput, token)).rejects.toThrow();
      expect(test.secrets.values.size).toBe(0);
      expect(test.state.values.size).toBe(0);
    }
  });

  it("keeps concurrent connection additions and rejects duplicate names", async () => {
    const { connections } = setupConnections();
    await Promise.all([
      connections.add(connectionInput, token),
      connections.add({ ...connectionInput, name: "staging" }, token),
    ]);
    expect(connections.list().map((item) => item.name)).toEqual(["production", "staging"]);
    await expect(connections.add(connectionInput, token)).rejects.toThrow("unique");
  });

  it("keeps a working token if replacement validation fails", async () => {
    const test = setupConnections();
    const connection = await test.connections.add(connectionInput, token);
    test.fetch.mockResolvedValueOnce(new Response("Forbidden", { status: 401 }));
    await expect(
      test.connections.updateToken(connection.id, "opsh_pat_rejected"),
    ).rejects.toThrow();
    expect([...test.secrets.values.values()]).toEqual([token]);
  });

  it("does not reuse credentials after a connection is removed", async () => {
    const test = setupConnections();
    const connection = await test.connections.add(connectionInput, token);
    const client = test.connections.client(connection.id);
    await test.connections.remove(connection.id);
    test.fetch.mockClear();
    await expect(client.projects.list()).rejects.toThrow("no longer available");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.secrets.values.size).toBe(0);
  });

  it("refuses an organization mismatch and a deployment from another project", async () => {
    const test = setupConnections();
    const connection = await test.connections.add(
      { ...connectionInput, organizationId: project.organizationId },
      token,
    );
    expect(() => test.connections.client(connection.id, "other-org")).toThrow(
      "different organization",
    );
    const previous = test.fetch.getMockImplementation()!;
    test.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/projects/${project.id}`))
        return Response.json({ data: { ...project, id: "other-project" } });
      return previous(input, init);
    });
    await expect(
      resolveProject(test.connections, { connectionId: connection.id, projectId: project.id }),
    ).rejects.toThrow("identity changed");
    test.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/deployments/${deployment.id}`))
        return Response.json({ data: { ...deployment, projectId: "other-project" } });
      return previous(input, init);
    });
    await expect(
      resolveDeployment(test.connections, {
        connectionId: connection.id,
        projectId: project.id,
        deploymentId: deployment.id,
      }),
    ).rejects.toThrow("does not belong");
  });

  it("redacts PATs from errors shown in the editor", () => {
    expect(errorMessage(new Error(`Server rejected ${token}`))).toBe(
      "Server rejected [redacted token]",
    );
  });

  it("preserves deployment preflight failures returned with HTTP 403", () => {
    const reason =
      "Pre-deploy checks failed: Build configuration: Missing required fields: build image";
    const error = new ApiError(reason, 403, {
      error: reason,
      code: "PRE_DEPLOY_CHECKS_FAILED",
    });
    expect(errorMessage(error)).toBe(reason);
  });

  it("redacts tokens in permission rejection details", () => {
    expect(errorMessage(new ApiError(`Access denied for ${token}`, 403, null))).toBe(
      "Access denied for [redacted token]",
    );
  });

  it.each(["Forbidden", "API error: 403", ""])(
    "offers permission guidance for a generic 403 response: %s",
    (message) => {
      expect(errorMessage(new ApiError(message, 403, null))).toBe(
        "This token cannot perform that operation. Check its permissions and the selected organization.",
      );
    },
  );
});
