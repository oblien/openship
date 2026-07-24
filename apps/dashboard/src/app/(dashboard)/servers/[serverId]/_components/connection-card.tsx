"use client";

import { Server, Globe, Network, User, KeyRound } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface ConnectionServer {
  sshHost: string;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthMethod?: string | null;
}

/** The server's SSH connection summary. Shared by the server-detail right sidebar
 *  and the Services tab (shown until a migrate scan replaces it with the config). */
export function ServerConnectionCard({ server }: { server: ConnectionServer }) {
  const { t } = useI18n();
  const d = t.servers.detail;
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Server className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">{d.connection}</h3>
      </div>
      <div className="space-y-3">
        <Row icon={<Globe className="size-4 text-muted-foreground" />} label={d.host}>
          <span className="text-sm font-medium text-foreground font-mono truncate ms-3 max-w-[140px]">
            {server.sshHost}
          </span>
        </Row>
        <Row icon={<Network className="size-4 text-muted-foreground" />} label={d.port}>
          <span className="text-sm font-medium text-foreground font-mono">{server.sshPort ?? 22}</span>
        </Row>
        <Row icon={<User className="size-4 text-muted-foreground" />} label={d.user}>
          <span className="text-sm font-medium text-foreground font-mono">{server.sshUser ?? "root"}</span>
        </Row>

        <div className="h-px bg-border/60 my-2" />

        <Row icon={<KeyRound className="size-4 text-muted-foreground" />} label={d.auth}>
          <span className="text-sm font-medium text-foreground">
            {server.sshAuthMethod === "key" ? d.authSshKey : d.authPassword}
          </span>
        </Row>
      </div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center">{icon}</div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      {children}
    </div>
  );
}
