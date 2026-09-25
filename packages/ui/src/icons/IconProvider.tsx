"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_ICON_THEME, LOCAL_ICON_BASE_URL, type IconTheme } from "./source";

interface IconConfiguration {
  readonly baseUrl: string;
  readonly theme: IconTheme;
}

const IconContext = createContext<IconConfiguration>({
  baseUrl: LOCAL_ICON_BASE_URL,
  theme: DEFAULT_ICON_THEME,
});

export function IconProvider({
  baseUrl,
  theme,
  children,
}: {
  baseUrl?: string;
  theme?: IconTheme;
  children: ReactNode;
}) {
  const parent = useContext(IconContext);
  const value = useMemo(
    () => ({ baseUrl: baseUrl ?? parent.baseUrl, theme: theme ?? parent.theme }),
    [baseUrl, theme, parent],
  );
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>;
}

export function useIconConfiguration(): IconConfiguration {
  return useContext(IconContext);
}
