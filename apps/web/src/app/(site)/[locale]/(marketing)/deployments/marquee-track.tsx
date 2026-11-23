"use client";

import type { ReactNode } from "react";
import styles from "./card-marquee.module.css";

// Adjust the running animation's speed while preserving its position in the loop.
function syncHoverSpeed(track: HTMLDivElement | null) {
  if (!track) return;
  const hovered = window.matchMedia("(hover: hover)").matches && track.matches(":hover");
  for (const animation of track.getAnimations()) {
    animation.updatePlaybackRate(hovered ? 0.65 : 1);
  }
}

export function MarqueeTrack({ children }: { children: ReactNode }) {
  return (
    <div
      className={`site-container ${styles.track}`}
      ref={syncHoverSpeed}
      onPointerEnter={(event) => syncHoverSpeed(event.currentTarget)}
      onPointerLeave={(event) => syncHoverSpeed(event.currentTarget)}
      onAnimationStart={(event) => {
        if (event.target === event.currentTarget) syncHoverSpeed(event.currentTarget);
      }}
    >
      {children}
    </div>
  );
}
