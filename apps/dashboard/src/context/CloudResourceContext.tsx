"use client";

import { createContext, useContext } from "react";

/** Non-secret connection identity for invalidating account-owned views. Kept
 * separate from the connect modal so shared inventory hooks have no UI cycle. */
export const CloudResourceContext = createContext("");
export const useCloudResourceKey = () => useContext(CloudResourceContext);

/** Initial identity resolution only; background status refreshes stay ready. */
export const CloudResourceReadyContext = createContext(true);
export const useCloudResourceReady = () => useContext(CloudResourceReadyContext);
