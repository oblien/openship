"use client";

import { useState } from "react";
import type { ServerOperations } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { systemApi } from "@/lib/api/system";
import { ManagedControlPanel, ConnectionValue } from "./ManagedControlPanel";
import { useManagedServerResource, useManagedServerSecret } from "./useManagedServerResource";

type Credential = Awaited<ReturnType<ServerOperations["managedRuntimeCredential"]>>;

export function ManagedServerRuntime({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const common = t.servers.managedControls,
    copy = common.runtime;
  const resource = useManagedServerResource(serverId, systemApi.managedRuntimeStatus);
  const credential = useManagedServerSecret<Credential>(serverId);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const status = resource.data;
  return (
    <ManagedControlPanel
      title={copy.title}
      description={copy.description}
      icon="code"
      {...resource}
    >
      {status ? (
        <>
          <p className="text-sm font-medium">
            {status.enabled == null
              ? common.unavailable
              : status.enabled
                ? common.enabled
                : common.disabled}
          </p>
          <p className="rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground">
            {copy.requiredHint}
          </p>
          {status.enabled === false && (
            <Button
              disabled={resource.busy || status.running !== true}
              onClick={() => {
                void resource.run(
                  () => systemApi.enableManagedRuntime(serverId, { confirm: true }),
                  resource.replace,
                );
              }}
            >
              {copy.enable}
            </Button>
          )}
          {status.running === false && (
            <p className="text-sm text-muted-foreground">{copy.stoppedHint}</p>
          )}
          {status.enabled === true && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{copy.credentialHint}</p>
              <Button
                disabled={resource.busy || status.running !== true}
                variant="secondary"
                onClick={() => {
                  credential.clear();
                  setConfirmRotate(false);
                  void resource.run(
                    () => systemApi.managedRuntimeCredential(serverId, { confirm: true }),
                    credential.reveal,
                  );
                }}
              >
                {copy.reveal}
              </Button>
            </div>
          )}
          {credential.value && (
            <div className="space-y-4 rounded-xl bg-muted/20 p-4">
              <p className="text-sm text-muted-foreground">{common.secretHint}</p>
              <ConnectionValue label={copy.endpoint} value={credential.value.endpoint} />
              <ConnectionValue label={copy.token} value={credential.value.token} secret />
              {credential.value.expiresAt && (
                <p className="text-xs text-muted-foreground">
                  {common.expires}: {new Date(credential.value.expiresAt).toLocaleString()}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    credential.clear();
                    setConfirmRotate(false);
                  }}
                >
                  {common.hideSecrets}
                </Button>
                <Button
                  variant="secondary"
                  disabled={resource.busy}
                  onClick={() => setConfirmRotate(true)}
                >
                  {copy.rotate}
                </Button>
              </div>
              {confirmRotate && (
                <div className="space-y-3 rounded-xl bg-warning/10 p-4">
                  <p className="text-sm">{copy.rotateHint}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="destructive"
                      disabled={resource.busy}
                      onClick={() => {
                        if (!credential.value) return;
                        const expectedRevision = credential.value.revision;
                        credential.clear();
                        setConfirmRotate(false);
                        void resource.run(
                          () =>
                            systemApi.rotateManagedRuntimeCredential(serverId, {
                              expectedRevision,
                              confirm: true,
                            }),
                          credential.reveal,
                        );
                      }}
                    >
                      {copy.confirmRotate}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={resource.busy}
                      onClick={() => setConfirmRotate(false)}
                    >
                      {common.cancel}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          <details className="rounded-xl bg-muted/20 p-4">
            <summary className="cursor-pointer text-sm font-medium">{copy.exampleTitle}</summary>
            <p className="mt-3 text-xs text-muted-foreground">{copy.exampleHint}</p>
            <pre
              dir="ltr"
              className="mt-3 overflow-x-auto whitespace-pre-wrap break-all text-xs"
            >{`import { Runtime } from 'oblien';\n\nconst server = new Runtime({\n  token: process.env.OBLIEN_RUNTIME_TOKEN,\n  baseUrl: process.env.OBLIEN_RUNTIME_URL,\n});\nconst result = await server.exec.run(['uname', '-a']);`}</pre>
          </details>
        </>
      ) : (
        resource.busy && <div className="h-32 animate-pulse rounded-xl bg-muted/40" />
      )}
    </ManagedControlPanel>
  );
}
