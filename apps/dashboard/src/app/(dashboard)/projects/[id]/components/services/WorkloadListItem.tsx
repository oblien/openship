"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";

/** App and service entries share column tracks, targets and responsive behavior. */
export function WorkloadListItem({
  name,
  href,
  icon,
  address,
  connectionLabel,
  port,
  portLabel,
  status,
  notice,
}: {
  name: string;
  href: string;
  icon: ReactNode;
  address: string;
  connectionLabel?: string;
  port?: number | null;
  portLabel?: string | null;
  status: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <li className="col-span-full grid grid-cols-subgrid">
      <Link
        href={href}
        prefetch={false}
        className="group col-span-full grid grid-cols-subgrid items-center px-4 py-3.5 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 @2xl/services-list:px-5"
      >
        <div className="flex min-w-0 items-center gap-3 @2xl/services-list:gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60 transition-colors group-hover:bg-muted">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="truncate text-sm font-medium text-foreground"
                title={name}
                dir="auto"
              >
                {name}
              </span>
              {notice}
            </div>
            <div
              className="mt-0.5 flex min-w-0 items-center text-xs text-muted-foreground"
              title={[address, connectionLabel].filter(Boolean).join(" · ")}
            >
              {connectionLabel && <span className="sr-only">{connectionLabel}: </span>}
              <span className="truncate" dir="auto">
                {address}
              </span>
            </div>
          </div>
        </div>
        <div className="hidden min-w-0 items-center justify-center @lg/services-list:flex">
          {portLabel && (
            <span
              className="font-mono text-xs tabular-nums text-muted-foreground"
              title={portLabel}
              dir="ltr"
            >
              <span className="sr-only">{portLabel}</span>
              <span aria-hidden="true">:{port}</span>
            </span>
          )}
        </div>
        <div className="grid items-center gap-3 whitespace-nowrap @sm/services-list:grid-cols-[minmax(0,1fr)_1rem]">
          <div className="flex items-center justify-center">{status}</div>
          <Icon
            name="chevron-right"
            className="hidden size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground rtl:rotate-180 @sm/services-list:block"
          />
        </div>
      </Link>
    </li>
  );
}
