"use client";

import { AppLogo } from "@repo/ui/app-logo";

export function MarketplaceLogo({
  id,
  logo,
  name,
  src,
  large = false,
}: {
  id: string;
  logo: string;
  name: string;
  src?: string;
  large?: boolean;
}) {
  return (
    <span
      className={`marketplace-logo ${large ? "marketplace-logo-large" : ""}`}
      aria-hidden="true"
    >
      <AppLogo
        invertOnDark={false}
        appId={id}
        slug={logo}
        src={src}
        className={large ? "size-11" : "size-7"}
        fallback={<span className="th-text-heading text-lg font-medium">{name.slice(0, 1)}</span>}
      />
    </span>
  );
}
