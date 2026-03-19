"use client";

import {
  Mail,
  Play,
  Server,
  Shield,
  Globe,
  Key,
  AlertTriangle,
} from "lucide-react";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";

interface MailSetupFormProps {
  domain: string;
  adminPassword: string;
  running: boolean;
  selectedServerId: string | null;
  onDomainChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onServerSelect: (s: ServerOption | null) => void;
  onStart: () => void;
}

export function MailSetupForm({
  domain,
  adminPassword,
  running,
  selectedServerId,
  onDomainChange,
  onPasswordChange,
  onServerSelect,
  onStart,
}: MailSetupFormProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
      {/* Setup form */}
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
            <Mail className="size-5 text-violet-500" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-foreground">Mail Server Setup</h2>
            <p className="text-sm text-muted-foreground">
              Deploy a full mail server powered by iRedMail
            </p>
          </div>
        </div>

        <ServerSelector
          value={selectedServerId}
          onSelect={onServerSelect}
        />

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Domain
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => onDomainChange(e.target.value)}
              placeholder="example.com"
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Your mail server will be at <strong>mail.{domain || "example.com"}</strong>
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Admin Password
            </label>
            <input
              type="password"
              value={adminPassword}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="Strong password for mail admin"
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
        </div>

        <button
          onClick={onStart}
          disabled={!domain || !adminPassword || !selectedServerId || running}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="size-4" />
          Start Setup
        </button>
      </div>

      {/* Info sidebar */}
      <div className="space-y-4">
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <p className="text-xs text-muted-foreground/60 uppercase tracking-wider font-semibold mb-4">
            What gets installed
          </p>
          <div className="space-y-3">
            {[
              { icon: Server, label: "iRedMail", desc: "Full mail server stack" },
              { icon: Shield, label: "SSL Certificate", desc: "Let's Encrypt auto-SSL" },
              { icon: Globe, label: "DNS Configuration", desc: "DKIM, SPF, DMARC records" },
              { icon: Key, label: "Admin Panel", desc: "Web-based mail management" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <item.icon className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Prerequisites</p>
              <ul className="text-xs text-muted-foreground mt-1.5 space-y-1 list-disc list-inside">
                <li>A domain with DNS access</li>
                <li>Port 25 not blocked by your provider</li>
                <li>Clean Ubuntu/Debian server (recommended)</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
