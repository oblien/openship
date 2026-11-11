"use client";

import { useId, type ReactNode, type SVGProps } from "react";

export type IllustrationArtwork = (id: string) => ReactNode;

export interface IllustrationFrameProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  artwork: IllustrationArtwork;
  title?: string;
}

/** One SVG frame for the approved artwork and the development preview generator. */
export function IllustrationFrame({ artwork, title, ...props }: IllustrationFrameProps) {
  const id = `illustration-${useId()}`;
  const labelled = Boolean(title || props["aria-label"] || props["aria-labelledby"]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={80}
      height={64}
      viewBox="0 0 80 64"
      fill="none"
      stroke="none"
      focusable="false"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-labelledby={title && !props["aria-label"] ? `${id}-title` : undefined}
      {...props}
    >
      {title && <title id={`${id}-title`}>{title}</title>}
      {artwork(id)}
    </svg>
  );
}
