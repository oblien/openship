"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_ICON_THEME, LOCAL_ICON_BASE_URL, type IconTheme } from "./source";

interface IconConfiguration {
  readonly baseUrl: string;
  readonly fallbackBaseUrl: string;
  readonly theme: IconTheme;
}

const IconContext = createContext<IconConfiguration>({
  baseUrl: LOCAL_ICON_BASE_URL,
  fallbackBaseUrl: LOCAL_ICON_BASE_URL,
  theme: DEFAULT_ICON_THEME,
});

export function IconProvider({
  baseUrl,
  fallbackBaseUrl,
  theme,
  children,
}: {
  baseUrl?: string;
  /** Host for default artwork after a custom asset fails. Inherited by nested providers. */
  fallbackBaseUrl?: string;
  theme?: IconTheme;
  children: ReactNode;
}) {
  const parent = useContext(IconContext);
  const value = useMemo(
    () => ({
      baseUrl: baseUrl ?? parent.baseUrl,
      fallbackBaseUrl: fallbackBaseUrl ?? parent.fallbackBaseUrl,
      theme: theme ?? parent.theme,
    }),
    [baseUrl, fallbackBaseUrl, theme, parent],
  );
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>;
}

export function useIconConfiguration(): IconConfiguration {
  return useContext(IconContext);
}
