import { useCopy } from "@/i18n/use-copy";

import type { ReactNode } from "react";
import { Link } from "@/i18n/Link";
import { ArrowUpRight } from "lucide-react";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";

export type IllustratedLinkProps = {
  href: string;
  illustration: FeatureIllustrationName;
  title: string;
  description: ReactNode;
  note?: ReactNode;
  heading?: "h2" | "h3";
  id?: string;
};

/** One open illustrated row, shared by features, guides and help links. */
export function IllustratedLink({
  href,
  illustration,
  title,
  description,
  note,
  heading: Heading = "h3",
  id,
}: IllustratedLinkProps) {
  const copy = useCopy();

  return (
    <Link id={id} href={href} className="marketing-link">
      <FeatureIllustration name={illustration} className="marketing-illustration" />
      <div className="marketing-link-copy">
        <Heading>{copy(title)}</Heading>
        <p>{copy(description)}</p>
        {note && <span>{copy(note)}</span>}
      </div>
      <ArrowUpRight className="marketing-link-arrow" aria-hidden="true" />
    </Link>
  );
}
