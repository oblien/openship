"use client";

import type { ReactNode } from "react";
import type { NetworkAccessPolicy } from "@repo/core";
import { NetworkFirewallRules, type NetworkFirewallServer } from "./NetworkFirewallRules";

/** Provider-side UDP access remains an explicit prerequisite of a reviewed plan. */
export function ManagedNetworkTransportNotice({
  failed = false,
  endpoints = [],
  access,
  children,
}: {
  failed?: boolean;
  endpoints?: NetworkFirewallServer[];
  access?: NetworkAccessPolicy;
  children?: ReactNode;
}) {
  return (
    <NetworkFirewallRules
      servers={endpoints}
      network={{ mode: "wireguard", access }}
      failed={failed}
    >
      {children}
    </NetworkFirewallRules>
  );
}
