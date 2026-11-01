"use client";

import { useEffect, useState } from "react";
import { isBuildClockRunning, resolveBuildElapsedMs, type BuildTimingState } from "./types";

/** Both build views use timestamps, so throttled background tabs catch up on
 *  their next render. The interval only schedules renders; it is not the clock. */
export function useBuildElapsedMs(state: BuildTimingState): number | null {
  const [, setTick] = useState(0);
  const running = isBuildClockRunning(state);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return resolveBuildElapsedMs(state);
}
