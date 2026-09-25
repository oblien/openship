"use client";

import { Icon, type IconProps } from "@repo/ui/icons";
import { useTheme } from "./theme-provider";

/** Show the current appearance consistently wherever the three-theme toggle lives. */
export function ThemeIcon(props: Omit<IconProps, "name">) {
  const { resolvedTheme } = useTheme();
  return (
    <Icon
      {...props}
      name={resolvedTheme === "light" ? "sun" : resolvedTheme === "dim" ? "sun-moon" : "moon"}
    />
  );
}
