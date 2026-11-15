import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";

/** Preview of an upcoming feature, using shared artwork when available. */
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
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {art ? (
        <FeatureIllustration
          name={art === "network" ? "private-networking" : "server-management"}
          className="illustration-color mb-4 h-auto w-20"
        />
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
