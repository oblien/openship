"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** One full-height transcript; the composer floats above it without shrinking the scrollport. */
export function AssistantConversationLayout({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const update = () => {
      container.current?.style.setProperty(
        "--assistant-composer-height",
        `${overlay.current?.offsetHeight ?? 0}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    if (overlay.current) observer.observe(overlay.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={container} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {children}
      <div
        ref={overlay}
        data-assistant-composer-overlay
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/95 to-transparent pt-8 pb-1"
      >
        <div className="pointer-events-auto mx-auto w-full max-w-3xl">{footer}</div>
      </div>
    </div>
  );
}
