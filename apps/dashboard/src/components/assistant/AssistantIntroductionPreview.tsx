"use client";

import { useId, useState } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { FeatureIllustration, type FeatureIllustrationName } from "@repo/ui/illustrations";
import { Tabs } from "@/components/ui/Tabs";

const examples = {
  deploy: {
    label: "Deploy",
    illustration: "push-to-deploy",
    title: "From repository to running app",
    prompt: "Deploy my API from GitHub and connect its domain.",
    steps: [
      "Inspect the repository",
      "Build and deploy the app",
      "Connect the domain and verify health",
    ],
    result: "Your API is live.",
    detail: "Build passed, domain connected, health checks passing.",
    resultIcon: "check",
    caption: "",
  },
  investigate: {
    label: "Investigate",
    illustration: "logs-monitoring",
    title: "Find the cause. Review the fix.",
    prompt: "The latest deploy failed. Find the cause and fix it.",
    steps: [
      "Read the build logs",
      "Trace the failure to a code change",
      "Prepare a fix in a pull request",
    ],
    result: "Fix ready to review.",
    detail: "A missing import broke the build. The patch is in a new branch.",
    resultIcon: "git-branch",
    caption: "",
  },
  automate: {
    label: "Automate",
    illustration: "jobs-triggers",
    title: "Give routine work a trigger",
    prompt: "When my app goes down, investigate and send me a report.",
    steps: [
      "Unhealthy service triggers an investigation",
      "Agent checks logs and recent changes",
      "Findings arrive in your chat",
    ],
    result: "An incident report, delivered to you.",
    detail: "Give it a scope, choose a trigger, and enable the automation.",
    resultIcon: "message",
    caption: "Automations run while OpenShip and your agent host are online.",
  },
} satisfies Record<
  string,
  {
    label: string;
    illustration: FeatureIllustrationName;
    title: string;
    prompt: string;
    steps: string[];
    result: string;
    detail: string;
    resultIcon: IconName;
    caption: string;
  }
>;

type ExampleKey = keyof typeof examples;
const exampleKeys = Object.keys(examples) as ExampleKey[];
const exampleTabs = exampleKeys.map((key) => ({
  key,
  label: examples[key].label,
}));

/** These labelled examples are local presentation; they never run an agent or a task. */
export function AssistantIntroductionPreview() {
  const [selected, setSelected] = useState<ExampleKey>("deploy");
  const id = useId();

  return (
    <div className="@container min-w-0 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">Explore an example</p>
        <Tabs
          tabs={exampleTabs}
          value={selected}
          onChange={setSelected}
          idPrefix={id}
          ariaLabel="What agents can do"
          variant="pills"
          size="sm"
          className="max-w-full"
        />
      </div>
      {exampleKeys.map((key) => {
        const example = examples[key];
        return (
          <section
            key={key}
            role="tabpanel"
            id={`${id}-panel-${key}`}
            aria-labelledby={`${id}-tab-${key}`}
            hidden={selected !== key}
            tabIndex={0}
            className="mt-6 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <div className="grid items-center gap-6 @[600px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div>
                <FeatureIllustration
                  name={example.illustration}
                  className="illustration-color mb-4 h-16 w-20"
                />
                <h3 className="text-lg font-medium leading-7 text-foreground">{example.title}</h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  &ldquo;{example.prompt}&rdquo;
                </p>
              </div>
              <div>
                <ol className="space-y-4" aria-label="Example actions">
                  {example.steps.map((step, index) => (
                    <li
                      key={step}
                      className="relative flex items-start gap-3 text-sm leading-5 text-muted-foreground"
                    >
                      {index < example.steps.length - 1 && (
                        <span
                          aria-hidden="true"
                          className="absolute start-3 top-6 -bottom-4 border-s border-border/60"
                        />
                      )}
                      <span
                        aria-hidden="true"
                        className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-foreground"
                      >
                        {index + 1}
                      </span>
                      <span className="py-0.5">{step}</span>
                    </li>
                  ))}
                </ol>
                <div className="mt-5 flex items-start gap-3 rounded-xl bg-card p-4">
                  <Icon
                    name={example.resultIcon}
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <div>
                    <p className="text-sm font-medium text-foreground">{example.result}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{example.detail}</p>
                  </div>
                </div>
              </div>
            </div>
            {example.caption && (
              <p className="mt-5 text-xs leading-5 text-muted-foreground">{example.caption}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
