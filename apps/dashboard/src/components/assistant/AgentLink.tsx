"use client";

import { createContext, useContext, type ComponentProps } from "react";
import Link from "next/link";

export const AgentNavigationContext = createContext<{
  href(destination: string): string;
  navigate(destination: string): void;
  close(): void;
  changed(): void;
  revision: number;
  open: boolean;
} | null>(null);

export const useAgentNavigation = () => useContext(AgentNavigationContext);

/** Ordinary links outside Assistant; in-place drawer navigation inside its layout. */
export function AgentLink({
  href,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const navigation = useAgentNavigation();
  const destination = navigation?.href(href);
  if (!destination || destination === href) return <Link {...props} href={href} />;
  return <Link {...props} href={destination} scroll={false} replace={navigation?.open ?? false} />;
}
