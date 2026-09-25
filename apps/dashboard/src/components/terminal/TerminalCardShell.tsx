"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Shared layout for Logs and Terminal panels: a service identity or picker,
 * optional search and status controls, the xterm mount, and an optional
 * centered overlay for empty/idle states.
 *
 * It is purely presentational — every consumer keeps its own transport
 * (SSE for logs, WebSocket PTY for the interactive shell) and just renders
 * through these slots so both surfaces look identical.
 */

import type { ReactNode } from "react";

interface TerminalCardShellProps {
    /** Titlebar label, e.g. the project or service name. */
    name: string;
    /** Optional service picker in place of the default icon and name. */
    title?: ReactNode;
    /** Search or filters; moves below the identity on narrow panels. */
    toolbar?: ReactNode;
    /** Right slot — streaming state, line count, start/stop, reconnect. */
    status?: ReactNode;
    /** Centered, non-interactive body overlay for empty/idle/connecting states. */
    overlay?: ReactNode;
    /** Appended to the outer wrapper. */
    className?: string;
    /** The xterm mount (and anything else that fills the body). */
    children: ReactNode;
}

export function TerminalCardShell({
    name,
    title,
    toolbar,
    status,
    overlay,
    className,
    children,
}: TerminalCardShellProps) {
    return (
        <div className={`flex min-w-0 flex-col h-full min-h-[460px] ${className ?? ""}`}>
            <div className="flex-1 flex flex-col min-h-0">
                <div className="@container bg-card rounded-2xl overflow-hidden flex-1 flex flex-col min-h-0">
                    {/* Titlebar */}
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                        <div className="min-w-0 flex-1 @3xl:w-52 @3xl:flex-none">
                            {title ?? (
                                <div className="flex h-9 min-w-0 items-center gap-2.5">
                                    <UiIcon name="terminal" className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate text-sm font-medium text-foreground" title={name}>{name}</span>
                                </div>
                            )}
                        </div>

                        {toolbar ? (
                            <div className="order-last w-full min-w-0 @3xl:order-none @3xl:w-auto @3xl:flex-1">{toolbar}</div>
                        ) : null}

                        {status ? (
                            <div className="ms-auto flex shrink-0 items-center gap-2 sm:gap-3">{status}</div>
                        ) : null}
                    </div>

                    {/* Body */}
                    <div className="relative flex-1 p-4 min-h-0">
                        {children}
                        {overlay ? (
                            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                                {overlay}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default TerminalCardShell;
