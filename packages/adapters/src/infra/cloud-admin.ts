import type { Oblien } from "oblien";

/** Organization-authorized provider operations delegated through the control plane. */
export interface CloudAdminProxy {
  /** SaaS delegates only after verifying each resource belongs to its namespace. */
  pages?: Pick<Oblien["pages"], "list" | "get" | "create" | "deploy" | "delete" | "enable" | "disable" | "getDomain" | "connectDomain" | "disconnectDomain" | "checkDNS" | "renewSSL">;
  setRoutes?: Oblien["routes"]["set"];
  domainRoutes?: () => ReturnType<Oblien["domain"]["routes"]>;
  domainSsls?: () => ReturnType<Oblien["domain"]["ssls"]>;
}
