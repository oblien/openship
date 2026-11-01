"use client";

import { createContext, useContext } from "react";
import type { CloudSupportApi } from "@/lib/api/cloud-support";

const SupportApiContext = createContext<CloudSupportApi | null>(null);
export const SupportApiProvider = SupportApiContext.Provider;

export function useSupportApi() {
  const client = useContext(SupportApiContext);
  if (!client) throw new Error("Support requires an account-bound API client");
  return client;
}
