"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type ComponentType } from "react";
import {
  DEFAULT_GIT_PROVIDER,
  GITHUB_PROVIDER,
  GIT_PROVIDERS,
  gitProviderDefinition,
  gitProviderSettingsHref,
} from "@repo/core";
import { GitProviderChoices } from "@/components/git/GitProviderSelect";
import { usePlatform } from "@/context/PlatformContext";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { GitHubConnection } from "./GitHubConnection";
import { GitHubSources } from "./GitHubSources";
import { CloneCredentials } from "./CloneCredentials";
import { Connections } from "./Connections";

function GitHubSettings() {
  const { selfHosted } = usePlatform();
  const [cloneOpen, setCloneOpen] = useState(useSearchParams().get("view") === "clone");
  const cloneSection = useRef<HTMLDivElement>(null);
  return (
    <div className="space-y-4">
      <GitHubConnection
        embedded
        onManageClone={() => {
          setCloneOpen(true);
          cloneSection.current?.scrollIntoView({ block: "nearest" });
          cloneSection.current?.querySelector("button")?.focus({ preventScroll: true });
        }}
      />
      <div ref={cloneSection} id="clone-credentials">
        <CloneCredentials open={cloneOpen} onOpenChange={setCloneOpen} />
      </div>
      {selfHosted && <GitHubSources collapsible />}
    </div>
  );
}

// Credential-backed providers use the shared editor. GitHub also manages App installations
// and per-user clone credentials, which have their own permissions and lifecycle.
const providerPanels = new Map<string, ComponentType>([[GITHUB_PROVIDER.id, GitHubSettings]]);

export function GitProviderSettings() {
  const router = useRouter();
  const workspace = useResourceScope();
  const requested = useSearchParams().get("provider");
  const selected = gitProviderDefinition(requested)?.id ?? DEFAULT_GIT_PROVIDER;
  const Panel = providerPanels.get(selected);
  return (
    <div className="min-w-0 space-y-4">
      <GitProviderChoices
        providers={GIT_PROVIDERS}
        value={selected}
        onChange={(id) => router.replace(gitProviderSettingsHref(id), { scroll: false })}
        segmented
        idPrefix="git-settings"
      />
      <div
        key={workspace + ":" + selected}
        id={`git-settings-panel-${selected}`}
        role="tabpanel"
        aria-labelledby={`git-settings-tab-${selected}`}
      >
        {Panel ? <Panel /> : <Connections gitProvider={selected} />}
      </div>
    </div>
  );
}
