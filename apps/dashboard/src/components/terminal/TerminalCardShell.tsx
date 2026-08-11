"use client";

/**
 * The chrome shared by the Logs and Terminal panels: a framed card with a
 * macOS-style titlebar (traffic lights + terminal icon + name), an optional
 * center toolbar slot, an optional right status slot, a body that hosts the
 * xterm mount, and an optional centered overlay for empty/idle states.
 *
 * It is purely presentational — every consumer keeps its own transport
 * (SSE for logs, WebSocket PTY for the interactive shell) and just renders
 * through these slots so both surfaces look identical.
 */

import type { ReactNode } from "react";
import { Terminal as TerminalIcon } from "lucide-react";

interface TerminalCardShellProps {
    /** Titlebar label, e.g. the project or service name. */
    name: string;
    /** Center slot — search, filters, etc. Pass the sizing wrapper yourself. */
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
    toolbar,
    status,
    overlay,
    className,
    children,
}: TerminalCardShellProps) {
    return (
        <div className={`flex flex-col h-full min-h-[460px] ${className ?? ""}`}>
            <div className="flex-1 flex flex-col min-h-0">
                <div className="bg-card rounded-2xl overflow-hidden border border-border/50 flex-1 flex flex-col min-h-0">
                    {/* Titlebar */}
                    <div className="px-5 py-3 border-b border-border/50">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="flex gap-2">
                                    <div className="w-3 h-3 rounded-full bg-gradient-to-br from-red-400 to-red-500 shadow-sm"></div>
                                    <div className="w-3 h-3 rounded-full bg-gradient-to-br from-yellow-400 to-yellow-500 shadow-sm"></div>
                                    <div className="w-3 h-3 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 shadow-sm"></div>
                                </div>
                                <TerminalIcon className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground/80">{name}</span>
                            </div>

                            {toolbar}

                            {status ? (
                                <div className="flex items-center gap-2 sm:gap-3">{status}</div>
                            ) : null}
                        </div>
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
