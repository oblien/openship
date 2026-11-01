"use client";

import { ControlButton, Controls, useReactFlow, useStore } from "@xyflow/react";
import { Icon } from "@repo/ui/icons";

/** React Flow owns viewport changes and limits; the buttons use our icon catalog. */
export function NetworkViewControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const maxZoomReached = useStore((state) => state.transform[2] >= state.maxZoom);
  const minZoomReached = useStore((state) => state.transform[2] <= state.minZoom);
  const labels = useStore((state) => state.ariaLabelConfig);

  return (
    <Controls
      showZoom={false}
      showFitView={false}
      showInteractive={false}
      className="!overflow-hidden !rounded-xl !border-0 !shadow-none [&>button]:!border-border/30 [&>button]:!bg-popover [&>button]:!text-foreground"
    >
      <ControlButton
        className="react-flow__controls-zoomin"
        onClick={() => void zoomIn()}
        disabled={maxZoomReached}
        title={labels["controls.zoomIn.ariaLabel"]}
        aria-label={labels["controls.zoomIn.ariaLabel"]}
      >
        <Icon name="plus" size={12} />
      </ControlButton>
      <ControlButton
        className="react-flow__controls-zoomout"
        onClick={() => void zoomOut()}
        disabled={minZoomReached}
        title={labels["controls.zoomOut.ariaLabel"]}
        aria-label={labels["controls.zoomOut.ariaLabel"]}
      >
        <Icon name="minus" size={12} />
      </ControlButton>
      <ControlButton
        className="react-flow__controls-fitview"
        onClick={() => void fitView()}
        title={labels["controls.fitView.ariaLabel"]}
        aria-label={labels["controls.fitView.ariaLabel"]}
      >
        <Icon name="expand" size={12} />
      </ControlButton>
    </Controls>
  );
}
