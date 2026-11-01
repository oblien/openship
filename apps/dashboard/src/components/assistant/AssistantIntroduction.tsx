import { Icon } from "@repo/ui/icons";
import { ASSISTANT_PROVIDER_LABELS } from "@repo/contracts";
import type { ReactNode } from "react";
import { AssistantIntroductionPreview } from "./AssistantIntroductionPreview";

export function AssistantIntroduction({ children }: { children: ReactNode }) {
  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto">
      <section
        aria-labelledby="assistant-introduction-title"
        className="mx-auto grid w-full max-w-[1040px] items-center gap-8 py-8 sm:py-12 @[880px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] @[880px]:gap-12"
      >
        <div className="mx-auto w-full max-w-md">
          <h2
            id="assistant-introduction-title"
            className="text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl"
          >
            Put your agents
            <br />
            to work.
          </h2>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Deploy apps, investigate failures, and automate routine work. Connect the agents you
            already use, right here in OpenShip.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-foreground">
            {(["codex", "claude"] as const).map((provider) => (
              <span key={provider} className="inline-flex items-center gap-2">
                <Icon name={provider} className="size-5" />
                {ASSISTANT_PROVIDER_LABELS[provider]}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">or your own API</span>
          </div>
          <div className="mt-7 rounded-2xl bg-card p-5 sm:p-6">{children}</div>
        </div>
        <AssistantIntroductionPreview />
      </section>
    </div>
  );
}
