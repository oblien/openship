"use client";

import { useId, useRef, useState } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";

const examples = [
  {
    label: "Deploy",
    icon: "rocket",
    agent: "OpenShip assistant",
    avatar: "mint",
    prompt: "Deploy my API from GitHub and connect its domain.",
    steps: [
      "Inspect the repository",
      "Build and deploy the app",
      "Connect the domain and verify health",
    ],
    result: "Your API is live.",
    detail: "Build passed, domain connected, health checks passing.",
    caption: "From a request to a running app, in one conversation.",
    resultIcon: "check",
  },
  {
    label: "Investigate",
    icon: "search",
    agent: "Deployment investigator",
    avatar: "code",
    prompt: "The latest deploy failed. Find the cause and fix it.",
    steps: [
      "Read the build logs",
      "Trace the failure to a code change",
      "Prepare a fix in a pull request",
    ],
    result: "Found the cause. Fix ready to review.",
    detail: "A missing import broke the build. The patch is in a new branch.",
    caption: "An agent that follows the evidence and takes the next step.",
    resultIcon: "git-branch",
  },
  {
    label: "Automate",
    icon: "workflow",
    agent: "Production watcher",
    avatar: "server",
    prompt: "When my app goes down, investigate and send me a report.",
    steps: [
      "Unhealthy service triggers an investigation",
      "Agent checks logs and recent changes",
      "Findings arrive in your chat",
    ],
    result: "The next incident has an agent on it.",
    detail: "Give it a scope, choose a trigger, and enable the automation.",
    caption: "Around the clock, while OpenShip and your agent host are online.",
    resultIcon: "message",
  },
] satisfies Array<{
  label: string;
  icon: IconName;
  agent: string;
  avatar: string;
  prompt: string;
  steps: string[];
  result: string;
  detail: string;
  caption: string;
  resultIcon: IconName;
}>;

/** Switching these labelled examples never creates a conversation or runs a task. */
export function AssistantIntroductionPreview() {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const example = examples[selected];
  return (
    <div className="mx-auto w-full max-w-[540px] min-w-0 rounded-2xl bg-card">
      <div className="px-5 pt-5 sm:px-6 sm:pt-6">
        <p className="mb-3 text-xs font-medium text-muted-foreground">Explore an example</p>
        <div
          role="tablist"
          aria-label="What agents can do"
          className="flex gap-1 rounded-xl bg-background p-1"
        >
          {examples.map((item, index) => (
            <button
              key={item.label}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={selected === index}
              aria-controls={`${id}-panel`}
              tabIndex={selected === index ? 0 : -1}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === "ArrowRight") next = (index + 1) % examples.length;
                else if (event.key === "ArrowLeft")
                  next = (index + examples.length - 1) % examples.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = examples.length - 1;
                else return;
                event.preventDefault();
                setSelected(next);
                tabs.current[next]?.focus();
              }}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs transition-colors focus-visible:underline focus-visible:underline-offset-4 focus-visible:outline-none sm:text-sm",
                selected === index
                  ? "bg-card text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <Icon name={item.icon} className="size-4 shrink-0" />
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${selected}`}
        tabIndex={0}
        className="rounded-2xl p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-6"
      >
        <div className="flex items-center gap-2.5">
          <AgentAvatar icon={example.avatar} className="size-8" />
          <p className="min-w-0 text-sm font-medium text-foreground">{example.agent}</p>
        </div>
        <div className="mt-5">
          <p className="ms-auto max-w-[92%] rounded-2xl rounded-ee-md bg-muted px-4 py-3 text-sm leading-6 text-foreground">
            {example.prompt}
          </p>
          <ol className="my-6 space-y-4" aria-label="Example actions">
            {example.steps.map((step, index) => (
              <li
                key={index}
                className="relative flex items-start gap-3 text-[13px] leading-5 text-muted-foreground"
              >
                {index < example.steps.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute start-[9px] top-6 -bottom-3 border-s border-dashed border-border"
                  />
                )}
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon name="check" className="size-3 text-muted-foreground" />
                </span>
                {step}
              </li>
            ))}
          </ol>
          <div className="rounded-xl bg-muted/60 p-4">
            <p className="flex items-start gap-2.5 text-sm font-medium leading-6 text-foreground">
              <Icon name={example.resultIcon} className="mt-0.5 size-5 shrink-0 text-success" />
              {example.result}
            </p>
            <p className="mt-1 ps-[30px] text-xs leading-5 text-muted-foreground">
              {example.detail}
            </p>
          </div>
        </div>
      </div>
      <p className="border-t border-border/40 px-5 py-4 text-xs leading-5 text-muted-foreground sm:px-6">
        {example.caption}
      </p>
    </div>
  );
}
