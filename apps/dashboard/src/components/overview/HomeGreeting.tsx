"use client";

import { useEffect, useState } from "react";
import { interpolate, useI18n } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

export function greetingForHour(hour: number, copy: Dictionary["dashboard"]["home"]): string {
  if (hour < 12) return copy.goodMorning;
  if (hour < 18) return copy.goodAfternoon;
  return copy.goodEvening;
}

/**
 * Keep the server and first client render identical, then reconcile to the
 * browser's local clock. Reading `new Date()` during render made the greeting
 * depend on two different clocks and caused a recoverable hydration error for
 * users whose timezone did not match the server.
 */
export default function HomeGreeting({
  displayName,
  initialHour,
}: {
  displayName: string;
  initialHour: number;
}) {
  const { t } = useI18n();
  const [hour, setHour] = useState(initialHour);

  useEffect(() => {
    setHour(new Date().getHours());
  }, []);

  const greeting = greetingForHour(hour, t.dashboard.home);
  return (
    <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
      {displayName
        ? interpolate(t.dashboard.home.greetingName, { greeting, name: displayName })
        : greeting}
    </h1>
  );
}
