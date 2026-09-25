import type { ReactNode } from "react";

/** Keep log navigation above details beside the console, and before it on narrow screens. */
export function DeploymentLayout({
  children,
  details,
  navigation,
}: {
  children: ReactNode;
  details: ReactNode;
  navigation: ReactNode;
}) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-rows-[auto_1fr]">
      <div className="min-w-0 xl:col-start-2 xl:row-start-1">{navigation}</div>
      <div className="min-w-0 space-y-5 xl:col-start-1 xl:row-span-2 xl:row-start-1">
        {children}
      </div>
      <div className="min-w-0 xl:col-start-2 xl:row-start-2">{details}</div>
    </div>
  );
}
