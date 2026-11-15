import { useCopy } from "@/i18n/use-copy";

import Image from "next/image";
import { useLocale } from "next-intl";
import { localizedScreenshot } from "@/lib/marketing-screenshots";

/** A real product capture; features without one use the ordinary text layout. */
export function FeatureShot({
  src,
  alt,
  priority = false,
}: {
  src: string;
  alt: string;
  priority?: boolean;
}) {
  const copy = useCopy();
  const locale = useLocale();

  return (
    <figure className="ft-shot">
      <div className="ft-shot-bar" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="ft-shot-body">
        <Image
          src={localizedScreenshot(src, locale)}
          alt={copy(alt)}
          fill
          priority={priority}
          sizes="(max-width: 1000px) 100vw, 600px"
          className="ft-shot-img"
        />
      </div>
    </figure>
  );
}
