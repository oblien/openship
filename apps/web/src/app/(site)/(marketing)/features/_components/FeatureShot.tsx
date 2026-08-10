import Image from "next/image";
import type { LucideIcon } from "lucide-react";

/**
 * A product screenshot in a browser frame. When `src` is null (no capture yet)
 * it renders a tasteful placeholder — the feature's mark on frosted chrome —
 * so the layout is complete before real screenshots are dropped in.
 */
export function FeatureShot({
  src,
  alt,
  Icon,
  priority = false,
}: {
  src: string | null;
  alt: string;
  Icon: LucideIcon;
  priority?: boolean;
}) {
  return (
    <figure className="ft-shot">
      <div className="ft-shot-bar" aria-hidden="true">
        <span className="ft-shot-dot" />
        <span className="ft-shot-dot" />
        <span className="ft-shot-dot" />
      </div>
      <div className="ft-shot-body">
        {src ? (
          <Image
            src={src}
            alt={alt}
            fill
            priority={priority}
            sizes="(max-width: 768px) 100vw, 920px"
            className="ft-shot-img"
          />
        ) : (
          <div className="ft-shot-empty" aria-label={`${alt} — screenshot coming soon`}>
            <Icon className="ft-shot-mark" strokeWidth={1.3} aria-hidden="true" />
            <span className="ft-shot-empty-label">Screenshot coming soon</span>
          </div>
        )}
      </div>
    </figure>
  );
}
