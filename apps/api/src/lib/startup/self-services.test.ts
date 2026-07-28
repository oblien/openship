import { describe, it, expect } from "vitest";
import type { DockerContainerSummary } from "@repo/adapters";
import { findOwnStack, portSpecs } from "./self-services";

const container = (
  over: Partial<DockerContainerSummary> & { id: string },
): DockerContainerSummary => ({
  names: [],
  image: "img",
  imageId: "sha256:x",
  state: "running",
  status: "Up 2 hours",
  labels: {},
  ports: [],
  mounts: [],
  ...over,
});

const stackMember = (service: string, project = "openship") =>
  container({
    id: `c_${project}_${service}`,
    names: [`${project}-${service}-1`],
    composeProject: project,
    composeService: service,
    labels: { "com.docker.compose.project": project, "com.docker.compose.service": service },
  });

describe("findOwnStack", () => {
  it("finds the compose stack that carries both api and dashboard", () => {
    const own = findOwnStack([
      stackMember("api"),
      stackMember("dashboard"),
      stackMember("postgres"),
      stackMember("redis"),
      stackMember("edge"),
    ]);
    expect(own.map((c) => c.composeService).sort()).toEqual([
      "api",
      "dashboard",
      "edge",
      "postgres",
      "redis",
    ]);
  });

  it("ignores unrelated stacks on the same host", () => {
    // A user's own supabase/n8n stacks must never be adopted as the control plane.
    const own = findOwnStack([
      stackMember("db", "supabase"),
      stackMember("studio", "supabase"),
      stackMember("n8n", "n8n"),
      stackMember("api"),
      stackMember("dashboard"),
    ]);
    expect(own.every((c) => c.composeProject === "openship")).toBe(true);
    expect(own).toHaveLength(2);
  });

  it("works when the compose project kept its legacy directory-derived name", () => {
    // Installs that predate the COMPOSE_PROJECT_NAME pin are named `compose`;
    // detection is by service membership, never by the project name.
    const own = findOwnStack([stackMember("api", "compose"), stackMember("dashboard", "compose")]);
    expect(own).toHaveLength(2);
    expect(own[0].composeProject).toBe("compose");
  });

  it("returns nothing when the stack is incomplete (dashboard missing)", () => {
    expect(findOwnStack([stackMember("api"), stackMember("postgres")])).toEqual([]);
  });

  it("returns nothing for containers with no compose labels (bare install)", () => {
    expect(findOwnStack([container({ id: "c1", names: ["openship-api"] })])).toEqual([]);
  });
});

describe("portSpecs", () => {
  it("emits host:container specs for published ports only", () => {
    const c = container({
      id: "c1",
      ports: [
        { privatePort: 3001, publicPort: 3001, type: "tcp" },
        { privatePort: 5432, type: "tcp" }, // internal — not published
      ],
    });
    expect(portSpecs(c)).toEqual(["3001:3001"]);
  });

  it("dedupes the IPv4/IPv6 double-listing docker reports for one binding", () => {
    const c = container({
      id: "c1",
      ports: [
        { privatePort: 3001, publicPort: 3001, type: "tcp" },
        { privatePort: 3001, publicPort: 3001, type: "tcp" },
      ],
    });
    expect(portSpecs(c)).toEqual(["3001:3001"]);
  });

  it("is empty for a container that publishes nothing", () => {
    expect(portSpecs(container({ id: "c1" }))).toEqual([]);
  });
});
