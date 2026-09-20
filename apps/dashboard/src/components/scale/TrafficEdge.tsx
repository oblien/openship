"use client";

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export type ScaleFlowEdge = Edge<
  { label: string; showLabel?: boolean; enabled?: boolean },
  "traffic"
>;

export const TrafficEdge = memo(function TrafficEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<ScaleFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={`scale-traffic-edge${selected ? " is-selected" : ""}${data?.enabled === false ? " is-disabled" : ""}`}
        interactionWidth={24}
      />
      {(selected || data?.showLabel) && (
        <EdgeLabelRenderer>
          <span
            className={`scale-edge-label${selected ? " is-selected" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data?.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
