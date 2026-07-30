import { describe, expect, it } from "vitest";
import {
  describeSwarmTaskOwnership,
  isSwarmTaskContainer,
  swarmTaskOwnership,
} from "./ownership";

describe("Swarm task ownership", () => {
  it("normalizes Docker's task and stack labels", () => {
    const labels = {
      "com.docker.swarm.service.id": "svc-id",
      "com.docker.swarm.service.name": "blog_web",
      "com.docker.stack.namespace": "blog",
      "com.docker.swarm.task.id": "task-id",
    };
    const ownership = swarmTaskOwnership(labels);

    expect(ownership).toEqual({
      serviceId: "svc-id",
      serviceName: "blog_web",
      stackName: "blog",
      taskId: "task-id",
    });
    expect(isSwarmTaskContainer(labels)).toBe(true);
    expect(describeSwarmTaskOwnership(ownership!)).toBe("blog/blog_web");
  });

  it("recognizes partial task ownership metadata and ignores ordinary containers", () => {
    expect(isSwarmTaskContainer({ "com.docker.swarm.task.id": "task-id" })).toBe(true);
    expect(swarmTaskOwnership({ "com.docker.compose.project": "blog" })).toBeUndefined();
  });
});
