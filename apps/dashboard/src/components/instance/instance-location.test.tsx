import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstanceProgress, instanceProgress } from "./InstanceLocation";
import type { InstanceStatus } from "@/lib/api/instance";

const state: InstanceStatus = {
  protocol: 1,
  role: "frozen",
  installationId: "source",
  version: "0.8.2",
  desktop: true,
  connection: null,
  localHosts: [],
  handoff: {
    id: "move",
    direction: "source",
    status: "frozen",
    running: false,
    error: "Connection interrupted",
    peerOrigin: "https://ops.example.com",
    provisioning: null,
  },
};
describe("instance handoff recovery UI", () => {
  it("offers recovery when transfer stops, without claiming the move is complete", () => {
    const html = renderToStaticMarkup(<InstanceProgress state={state} refresh={async () => {}} />);
    expect(html).toContain("Connection interrupted");
    expect(html).toContain("Resume move");
    expect(html).toContain("Cancel move");
  });
  it("never offers cancellation after source retirement", () => {
    const retired = {
      ...state,
      role: "retired",
      handoff: { ...state.handoff!, status: "retired" },
    } as InstanceStatus;
    const html = renderToStaticMarkup(
      <InstanceProgress state={retired} refresh={async () => {}} />,
    );
    expect(html).toContain("Resume move");
    expect(html).not.toContain("Cancel move");
    expect(instanceProgress(retired)).toBe("Connecting to the new control plane");
  });
});
