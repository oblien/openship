import type { ControllerRole } from "@repo/core";
import { api } from "./client";
import { endpoints } from "./endpoints";

export interface InstanceStatus {
  protocol: 1;
  role: ControllerRole;
  ready?: boolean;
  installationId: string;
  version: string;
  desktop: boolean;
  accountReady?: boolean;
  connection: { origin: string; installationId: string } | null;
  previousInstance?: { origin: string } | null;
  localHosts: Array<{ id: string; name: string }>;
  handoff: {
    id: string;
    direction: "source" | "target";
    status: "offered" | "frozen" | "copying" | "prepared" | "retired" | "complete" | "aborted";
    running: boolean;
    error: string | null;
    peerOrigin: string | null;
    provisioning: {
      projectId?: string;
      deploymentId?: string;
      access: "desktop" | "browser";
    } | null;
  } | null;
}
export type InstanceHostMapping = { sourceServerId: string; connectionServerId: string };
const path = endpoints.instance.status;
export const instanceApi = {
  status: () => api.get<InstanceStatus>(path),
  connectedSource: () => api.get<Pick<InstanceStatus, "localHosts">>(`${path}?source=connected`),
  connectedSession: () => api.get<{ user?: { id: string } } | null>("/api/auth/get-session"),
  preflight: (mapping?: InstanceHostMapping) => api.post(`${path}/preflight`, { mapping }),
  offer: (direction: "source" | "target", mapping?: InstanceHostMapping) =>
    api.post<{ code: string }>(`${path}/offer`, { direction, mapping }),
  move: (code: string, mapping?: InstanceHostMapping) =>
    api.post(`${path}/move`, { code, mapping, confirmReplace: true }),
  provision: (input: {
    serverId: string;
    access: "desktop" | "browser";
    domain: { kind: "custom" | "free"; hostname: string };
    mapping?: InstanceHostMapping;
  }) => api.post(`${path}/provision`, { ...input, confirmed: true }),
  resume: () => api.post(`${path}/resume`),
  cancel: () => api.post(`${path}/cancel`),
  pair: () => api.post<{ code: string }>(`${path}/pair`),
  connect: (code: string) => api.post(`${path}/connect`, { code }),
  connectAddress: (origin: string) =>
    api.post(`${path}/connect-address`, { origin, confirmed: true }),
  disconnect: () => api.post(`${path}/disconnect`),
  returnToDesktop: (mapping?: InstanceHostMapping) =>
    api.post(`${path}/return`, { confirmReplace: true, mapping }),
  moveToPrevious: (mapping?: InstanceHostMapping) =>
    api.post(`${path}/move-previous`, { confirmReplace: true, mapping }),
};
