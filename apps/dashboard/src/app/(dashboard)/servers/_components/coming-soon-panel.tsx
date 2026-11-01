import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import {
  PrivateNetworkIllustration,
  ServerClusterIllustration,
} from "@/components/servers/InfrastructureIllustrations";

/**
 * Preview placeholder for features that have not shipped yet. Uses the same illustration language as the empty states — a
 * themed monochrome (--th-*) vector that shows what the feature will do — plus
 * a "Coming soon" chip, title, and blurb. Pass `art` for the illustration;
 * `icon` is a fallback tile when no art matches.
 */
export function ComingSoonPanel({
  icon: Icon,
  art,
  title,
  body,
  badge,
}: {
  icon?: IconName;
  art?: "cluster" | "network";
  title: string;
  body: string;
  badge: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {art === "cluster" ? (
        <ServerClusterIllustration className="mb-8" />
      ) : art === "network" ? (
        <PrivateNetworkIllustration className="mb-8" />
      ) : Icon ? (
        <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-muted">
          <UiIcon name={Icon} className="size-6 text-muted-foreground" />
        </div>
      ) : null}

      <div className="mb-3 inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {badge}
      </div>
      <h3 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
        {title}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground/70">
        {body}
      </p>
    </div>
  );
}
