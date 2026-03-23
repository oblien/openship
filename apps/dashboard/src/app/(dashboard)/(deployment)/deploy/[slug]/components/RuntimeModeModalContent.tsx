"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Rocket, Terminal } from "lucide-react";
import { useMonitorStream } from "@/hooks/useMonitorStream";
import type { RuntimeMode } from "@/context/deployment/types";

const TWO_GB = 2 * 1024 * 1024 * 1024;

interface RuntimeModeModalContentProps {
  initialRuntimeMode: RuntimeMode;
  serverId?: string;
  onClose: () => void;
  onConfirm: (runtimeMode: RuntimeMode) => void | Promise<void>;
}

const runtimeOptions: Array<{
  value: RuntimeMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "bare",
    label: "Direct",
    description: "Run as a system process. Lightweight, no Docker required.",
    icon: <Terminal className="size-5" />,
  },
  {
    value: "docker",
    label: "Docker",
    description: "Run in an isolated container. Requires Docker on the server.",
    icon: <Box className="size-5" />,
  },
];

const RuntimeModeModalContent: React.FC<RuntimeModeModalContentProps> = ({
  initialRuntimeMode,
  serverId,
  onClose,
  onConfirm,
}) => {
  const { stats } = useMonitorStream(serverId ?? null, true);
  const hasAutoDefaultedRef = useRef(false);
  const hasUserSelectedRef = useRef(false);
  const [selectedRuntimeMode, setSelectedRuntimeMode] = useState<RuntimeMode>(initialRuntimeMode);

  const recommendedMode = useMemo<RuntimeMode | null>(() => {
    if (!stats) return null;
    return stats.memTotal < TWO_GB ? "bare" : "docker";
  }, [stats]);

  useEffect(() => {
    if (!recommendedMode || hasAutoDefaultedRef.current || hasUserSelectedRef.current) return;
    hasAutoDefaultedRef.current = true;
    setSelectedRuntimeMode(recommendedMode);
  }, [recommendedMode]);

  const ramGB = stats ? (stats.memTotal / (1024 * 1024 * 1024)).toFixed(1) : null;

  return (
    <div className="space-y-4 px-5 pb-5 pt-1">
      <div>
        <h2 className="text-lg font-semibold text-foreground">How should it run?</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Choose the runtime for this deployment
          {ramGB ? ` — server has ${ramGB} GB RAM` : ""}
        </p>
      </div>

      <div className="space-y-2">
        {runtimeOptions.map((option) => {
          const selected = selectedRuntimeMode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                hasUserSelectedRef.current = true;
                setSelectedRuntimeMode(option.value);
              }}
              className={`w-full rounded-xl border p-3 text-left transition-all ${
                selected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border/50 hover:border-border hover:bg-muted/30"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className={selected ? "text-primary" : "text-muted-foreground"}>
                  {option.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium ${selected ? "text-foreground" : "text-muted-foreground"}`}>
                    {option.label}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {option.description}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-xl border border-border/50 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onConfirm(selectedRuntimeMode)}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90"
        >
          <Rocket className="size-4" />
          Deploy
        </button>
      </div>
    </div>
  );
};

export default React.memo(RuntimeModeModalContent);