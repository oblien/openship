import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { INVITATION_DELIVERY_HEADER, INVITATION_DELIVERY_LINK_ONLY, parseDesktopInstanceLink } from "@repo/core";
import { freePort, startApi, stopApi, jsonRequest, type RunningApi } from "./fixtures/instance-api";

/** Isolated real API processes and disposable databases; no Docker, SSH,
 * developer environment files, live accounts or outbound email. */
it("joins a remote team through Desktop with the recipient's own account and permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "openship-instance-invitation-"));
  let remote: RunningApi | undefined, desktop: RunningApi | undefined;
  const remoteConfig = {
    dbDir: join(root, "remote"),
    port: await freePort(),
    apiOnly: true,
    secret: "remote-invitation-fixture-00000000000000000",
  };
  const post = <T>(
    api: RunningApi,
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => jsonRequest<T>(api.baseUrl, path, { method: "POST", body: JSON.stringify(body), headers });
  type Session = {
    user: { id: string; email: string; role: string };
    session: { activeOrganizationId: string };
  };
  try {
    // The existing account setup API bootstraps this disposable instance, then
    // we restart it with normal server authentication (no Desktop zero-auth).
    remote = await startApi(remoteConfig);
    await post(remote, "/api/system/upgrade-to-auth", {
      name: "Instance owner",
      email: "owner@example.test",
      password: "owner-fixture-password-123!",
    });
    await stopApi(remote);
    remote = await startApi({ ...remoteConfig, authMode: "local" });
    desktop = await startApi({
      dbDir: join(root, "desktop"),
      port: await freePort(),
      secret: "desktop-invitation-fixture-000000000000000",
    });
    await post(desktop, "/api/system/instance/connect-address", {
      origin: remote.baseUrl,
      confirmed: true,
    });
    expect(await jsonRequest(desktop.baseUrl, "/api/auth/get-session")).toBeNull();
    // URL discovery did not copy the Desktop owner's session to the server.
    const denied = await fetch(`${desktop.baseUrl}/api/permissions/workspaces`);
    expect(denied.status).toBe(401);
    await post(desktop, "/api/auth/sign-in/email", {
      email: "owner@example.test",
      password: "owner-fixture-password-123!",
    });
    const owner = await jsonRequest<Session>(desktop.baseUrl, "/api/auth/get-session");
    expect(owner.user.email).toBe("owner@example.test");
    // Opening another invitation on the same instance must not log the user out.
    await post(desktop, "/api/system/instance/connect-address", { origin: remote.baseUrl, confirmed: true });
    expect((await jsonRequest<Session>(desktop.baseUrl, "/api/auth/get-session")).user.id).toBe(owner.user.id);
    const team = await post<{ data: { id: string } }>(desktop, "/api/permissions/create-team-org", {
      name: "Remote team",
    });
    await post(desktop, "/api/auth/organization/set-active", { organizationId: team.data.id });
    const invite = await post<{ data: { id: string; email: string } }>(
      desktop,
      "/api/permissions/invite-with-grants",
      {
        email: "member@example.test",
        role: "restricted",
        grants: [],
      },
      { [INVITATION_DELIVERY_HEADER]: INVITATION_DELIVERY_LINK_ONLY },
    );
    expect(invite.data.email).toBe("member@example.test");
    const landing = await fetch(`${remote.baseUrl}/accept-invite/${invite.data.id}`);
    expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await landing.text();
    const desktopLink = html.match(/href="(openship:[^"]+)"/)?.[1];
    expect(desktopLink).toBeDefined();
    expect(parseDesktopInstanceLink(desktopLink!)).toBe(`${remote.baseUrl}/accept-invite/${invite.data.id}`);
    expect(html).toContain("Connect to an existing instance");
    expect(html).not.toContain("member@example.test");
    const wrongAccount = await fetch(`${desktop.baseUrl}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: invite.data.id }),
    });
    expect(wrongAccount.ok).toBe(false);
    await post(desktop, "/api/auth/sign-out", {});
    expect(await jsonRequest(desktop.baseUrl, "/api/auth/get-session")).toBeNull();

    const preview = await jsonRequest<{
      data: {
        accountCreation: string;
        organization: { name: string };
        invitation: { email: string };
      };
    }>(desktop.baseUrl, `/api/auth/invitation-preview/${invite.data.id}`);
    expect(preview.data).toMatchObject({
      accountCreation: "invited",
      organization: { name: "Remote team" },
      inviter: { name: "Instance owner" },
      invitation: { email: "member@example.test" },
    });
    await post(desktop, "/api/system/invite-signup", {
      invitationId: invite.data.id,
      name: "Team member",
      password: "member-fixture-password-123!",
    });
    await post(desktop, "/api/auth/sign-in/email", {
      email: "member@example.test",
      password: "member-fixture-password-123!",
    });
    await post(desktop, "/api/auth/organization/accept-invitation", {
      invitationId: invite.data.id,
    });
    const member = await jsonRequest<Session>(desktop.baseUrl, "/api/auth/get-session");
    expect(member.user.email).toBe("member@example.test");
    expect(member.user.id).not.toBe(owner.user.id);
    expect(member.user.role).not.toBe("admin");
    expect(member.session.activeOrganizationId).toBe(team.data.id);
    const organizations = await jsonRequest<{ id: string; name: string }[]>(
      desktop.baseUrl,
      "/api/auth/organization/list",
    );
    expect(organizations).toContainEqual(
      expect.objectContaining({ id: team.data.id, name: "Remote team" }),
    );
    const current = await jsonRequest<{
      data: {
        currentOrganizationId: string;
        workspaces: { organizationId: string; role: string }[];
      };
    }>(desktop.baseUrl, "/api/permissions/workspaces");
    expect(current.data.currentOrganizationId).toBe(team.data.id);
    expect(current.data.workspaces).toContainEqual(
      expect.objectContaining({ organizationId: team.data.id, role: "restricted" }),
    );
    const adminOnly = await fetch(`${desktop.baseUrl}/api/system/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationMailSource: "cloud" }),
    });
    expect(adminOnly.ok).toBe(false);
    const replay = await fetch(`${desktop.baseUrl}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: invite.data.id }),
    });
    expect(replay.ok).toBe(false);
    await post(desktop, "/api/system/instance/disconnect", {});
    const local = await jsonRequest<Session>(desktop.baseUrl, "/api/auth/get-session");
    expect(local.user.email).not.toBe(member.user.email);
    const localWorkspaces = await jsonRequest<{
      data: { workspaces: { organizationId: string }[] };
    }>(desktop.baseUrl, "/api/permissions/workspaces");
    expect(localWorkspaces.data.workspaces.some((org) => org.organizationId === team.data.id)).toBe(
      false,
    );
  } finally {
    if (desktop) await stopApi(desktop);
    if (remote) await stopApi(remote);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
