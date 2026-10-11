"use client";

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState, useEffect, useRef, useCallback } from "react";
import '@xterm/xterm/css/xterm.css';
import './logs.css';
import type { Terminal } from "@xterm/xterm";
import { useLogStream } from "@/hooks/useSSEConnection";

import { useToast } from "@/context/ToastContext";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useTheme } from "@/components/theme-provider";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { TerminalCardShell } from "@/components/terminal/TerminalCardShell";
import { TerminalSearch } from "@/components/terminal/TerminalSearch";
import { TerminalFollowControls } from "@/components/terminal/TerminalFollowControls";
import { useTerminalFollow } from "@/components/terminal/useTerminalFollow";
import { Button } from "@/components/ui/button";

interface TerminalLogsProps {
    projectId: string;
    projectName: string;
    title?: React.ReactNode;
    streamTarget: string;
    onLogsChange: (logs: string[]) => void;
}

const LOG_HISTORY_TAIL = 1000;
const LOG_SCROLLBACK_ROWS = 10000;

const appendQueryParam = (target: string, key: string, value: string) => {
    if (!target) return target;
    const separator = target.includes('?') ? '&' : '?';
    return `${target}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

export const TerminalLogs: React.FC<TerminalLogsProps> = ({
    projectId,
    projectName,
    title,
    streamTarget,
    onLogsChange,
}) => {
    const { showToast } = useToast();
    const { t } = useI18n();
    const {
        terminalLogsData,
        addTerminalLog,
        clearTerminalLogs,
        setTerminalStreaming,
        setTerminalXtermInstance
    } = useProjectSettings();

    const { resolvedTheme } = useTheme();
    const isDarkMode = resolvedTheme !== "light"; // dim + dark both use the dark terminal

    const [searchQuery, setSearchQuery] = useState("");
    const [hasMatches, setHasMatches] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [terminalReady, setTerminalReady] = useState(false);
    const [readyTerminal, setReadyTerminal] = useState<Terminal | null>(null);
    const [olderTerminalRowsDiscarded, setOlderTerminalRowsDiscarded] = useState(false);
    const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "stopped" | "ended" | "failed">("stopped");
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<any>(null);
    const searchAddonRef = useRef<any>(null);
    const streamIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const lastLogSequenceRef = useRef(0); // Monotonic count survives the retained array reaching its cap.
    const manualStopRef = useRef(false);
    const containerExitedRef = useRef(false);
    const effectShows = useRef(false);
    const follow = useTerminalFollow(readyTerminal);

    useEffect(() => {
        setOlderTerminalRowsDiscarded(false);
        if (!readyTerminal) return;
        const writes = readyTerminal.onWriteParsed(() => {
            setOlderTerminalRowsDiscarded(
                readyTerminal.buffer.active.baseY >= (readyTerminal.options.scrollback ?? LOG_SCROLLBACK_ROWS),
            );
        });
        return () => writes.dispose();
    }, [readyTerminal]);
    const getDarkTheme = () => ({
        background: '#060606',
        foreground: '#e5e5e5',
        cursor: '#ffffff',
        cursorAccent: '#060606',
        selectionBackground: 'rgba(255, 255, 255, 0.25)',
        selectionForeground: '#ffffff',
        black: '#000',
        red: '#ff5556',
        green: '#51fa7b',
        yellow: '#f2fa8c',
        blue: '#6372a4',
        magenta: '#ff79c6',
        cyan: '#86eafd',
        white: '#d3d7cf',
        brightBlack: '#6b7280',
        brightRed: '#ff8888',
        brightGreen: '#7dffaa',
        brightYellow: '#f7ffb3',
        brightBlue: '#8a9cd6',
        brightMagenta: '#ffa1dd',
        brightCyan: '#b0f3ff',
        brightWhite: '#ffffff',
    });

    const getLightTheme = () => ({
        background: '#ffffff',
        foreground: '#1a1a1a',
        cursor: '#1a1a1a',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(59, 130, 246, 0.3)',
        selectionForeground: '#1a1a1a',
        black: '#1a1a1a',
        red: '#dc2626',
        green: '#16a34a',
        yellow: '#ca8a04',
        blue: '#2563eb',
        magenta: '#c026d3',
        cyan: '#0891b2',
        white: '#6b7280',
        brightBlack: '#4b5563',
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: '#eab308',
        brightBlue: '#3b82f6',
        brightMagenta: '#d946ef',
        brightCyan: '#06b6d4',
        brightWhite: '#111827',
    });

    const getTerminalTheme = () => isDarkMode ? getDarkTheme() : getLightTheme();
    const initializeTerminal = async () => {
        if (!terminalRef.current) return;

        const { Terminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        // const { WebLinksAddon } = await import('@xterm/addon-web-links');
        const { SearchAddon } = await import('@xterm/addon-search');

        const xterm = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            theme: getTerminalTheme(),
            scrollback: LOG_SCROLLBACK_ROWS,
            disableStdin: true,
            allowProposedApi: true,
            rightClickSelectsWord: false,
            macOptionIsMeta: true,
        });

        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();

        xterm.loadAddon(fitAddon);
        xterm.loadAddon(searchAddon);
        // xterm.loadAddon(new WebLinksAddon());

        searchAddonRef.current = searchAddon;

        xterm.open(terminalRef.current);

        // Add right-click copy functionality
        xterm.element?.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const selection = xterm.getSelection();
            if (selection) {
                navigator.clipboard.writeText(selection).then(() => {
                    // Clear the selection after copying
                    xterm.clearSelection();
                    // Show visual feedback
                    showToast(t.projectDetail.logs.terminal.copiedToClipboard, 'success');
                }).catch(err => {
                    errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Failed to copy text:', err);
                });
            }
        });


        xtermRef.current = { xterm, fitAddon };
        setReadyTerminal(xterm);
        setTerminalXtermInstance(xterm);
        showOblienHeader(xtermRef);

        const handleResize = () => {
            try {
                // Debounce resize to avoid multiple rapid calls
                setTimeout(() => {
                    if (fitAddon && xterm.element) {
                        fitAddon.fit();
                    }
                }, 100);
            } catch (e) {
                errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Resize error:', e);
            }
        };

        window.addEventListener('resize', handleResize);

        // Add ResizeObserver to handle container size changes
        let resizeObserver: ResizeObserver | null = null;
        if (terminalRef.current) {
            resizeObserver = new ResizeObserver(() => {
                handleResize();
            });
            resizeObserver.observe(terminalRef.current);
        }

        // Initial fit after a short delay to ensure DOM is ready
        setTimeout(() => {
            handleResize();
            // Mark terminal as ready after fit
            setTerminalReady(true);
        }, 150);

        return {
            cleanup: () => {
                window.removeEventListener('resize', handleResize);
                if (resizeObserver) {
                    resizeObserver.disconnect();
                }
                xterm.dispose();
                setReadyTerminal((current) => current === xterm ? null : current);
            }
        }
    }

    useEffect(() => {
        const data = initializeTerminal()
        return () => {
            setTerminalReady(false); // Reset ready state on unmount
            data?.then(data => {
                data?.cleanup()
            })
        }
    }, []);

    // Replay ALL stored logs when terminal mounts
    useEffect(() => {
        if (terminalReady && xtermRef.current?.xterm) {
            // Replay all stored logs
            terminalLogsData.logs.forEach((log) => {
                if (xtermRef.current?.xterm) {
                    xtermRef.current.xterm.write(log + '\r\n');
                }
            });

            lastLogSequenceRef.current = terminalLogsData.totalLogs;
        }
    }, [terminalReady]); // Only run when terminal becomes ready

    // Write NEW logs from context to terminal (live updates)
    useEffect(() => {
        if (terminalReady && xtermRef.current?.xterm && terminalLogsData.totalLogs > lastLogSequenceRef.current) {
            // The provider retains only the latest 1,000 entries. Sequence
            // numbers let the terminal append after that array stops growing.
            const firstRetainedSequence = terminalLogsData.totalLogs - terminalLogsData.logs.length;
            const firstNewIndex = Math.max(0, lastLogSequenceRef.current - firstRetainedSequence);
            const newLogs = terminalLogsData.logs.slice(firstNewIndex);
            newLogs.forEach(log => {
                if (xtermRef.current?.xterm) {
                    try {
                        xtermRef.current.xterm.write(log + '\r\n');
                    } catch (err) {
                        errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Error writing log to terminal:', err);
                    }
                }
            });

            lastLogSequenceRef.current = terminalLogsData.totalLogs;
        }
    }, [terminalLogsData.logs, terminalLogsData.totalLogs, terminalReady]); // Run when new logs arrive

    // Update terminal theme when global theme changes
    useEffect(() => {
        if (terminalLogsData.xtermInstance) {
            terminalLogsData.xtermInstance.options.theme = getTerminalTheme();
        }
    }, [resolvedTheme]);

    useEffect(() => {
        onLogsChange(terminalLogsData.logs);
    }, [terminalLogsData.logs, onLogsChange]);

    // Native search with debouncing for performance
    const performSearch = useCallback((query: string) => {
        if (!searchAddonRef.current) return;

        setIsSearching(false);

        if (!query.trim()) {
            // Clear all search decorations when search is empty
            if (searchAddonRef.current.clearDecorations) {
                searchAddonRef.current.clearDecorations();
            }
            if (searchAddonRef.current.clearActiveDecoration) {
                searchAddonRef.current.clearActiveDecoration();
            }
            setHasMatches(false);
            return;
        }

        try {
            // Clear previous search
            if (searchAddonRef.current.clearDecorations) {
                searchAddonRef.current.clearDecorations();
            }

            // Use native search addon with decorations enabled - highlights ALL matches like VS Code
            const found = searchAddonRef.current.findNext(query, {
                caseSensitive: false,
                wholeWord: false,
                regex: false,
                decorations: {
                    matchBackground: '#515c6a',
                    matchBorder: '#74879a',
                    matchOverviewRuler: '#515c6a',
                    activeMatchBackground: '#6372a4',
                    activeMatchBorder: '#86eafd',
                    activeMatchColorOverviewRuler: '#6372a4',
                }
            });

            setHasMatches(found);
            if (found) follow.pauseForInspection();
        } catch (error) {
            errorDiagnostics.warn("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Search addon error:', error);
            setHasMatches(false);
        }
    }, [follow.pauseForInspection]);

    // Debounced search effect
    useEffect(() => {
        if (!searchAddonRef.current) return;

        // Clear previous debounce timer
        if (searchDebounceRef.current) {
            clearTimeout(searchDebounceRef.current);
        }

        // Set searching state immediately for UX feedback
        if (searchQuery.trim()) {
            setIsSearching(true);
        }

        // Debounce search by 300ms
        searchDebounceRef.current = setTimeout(() => {
            performSearch(searchQuery);
        }, 300);

        return () => {
            if (searchDebounceRef.current) {
                clearTimeout(searchDebounceRef.current);
            }
        };
    }, [searchQuery, performSearch]);

    const handleSearchNext = () => {
        if (!searchAddonRef.current || !searchQuery || !hasMatches) return;
        try {
            // Navigate to next match with decorations
            const found = searchAddonRef.current.findNext(searchQuery, {
                caseSensitive: false,
                wholeWord: false,
                regex: false,
                decorations: {
                    matchBackground: '#515c6a',
                    matchBorder: '#74879a',
                    matchOverviewRuler: '#515c6a',
                    activeMatchBackground: '#6372a4',
                    activeMatchBorder: '#86eafd',
                    activeMatchColorOverviewRuler: '#6372a4',
                }
            });
            if (found) follow.pauseForInspection();
        } catch (error) {
            errorDiagnostics.warn("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Search next error:', error);
        }
    };

    const handleSearchPrevious = () => {
        if (!searchAddonRef.current || !searchQuery || !hasMatches) return;
        try {
            // Navigate to previous match with decorations
            const found = searchAddonRef.current.findPrevious(searchQuery, {
                caseSensitive: false,
                wholeWord: false,
                regex: false,
                decorations: {
                    matchBackground: '#515c6a',
                    matchBorder: '#74879a',
                    matchOverviewRuler: '#515c6a',
                    activeMatchBackground: '#6372a4',
                    activeMatchBorder: '#86eafd',
                    activeMatchColorOverviewRuler: '#6372a4',
                }
            });
            if (found) follow.pauseForInspection();
        } catch (error) {
            errorDiagnostics.warn("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Search previous error:', error);
        }
    };

    // Create ref wrapper for terminal instance that always points to context
    const xtermInstanceRef = useRef<any>(null);

    // Keep ref in sync with context - this ensures SSE writes to current terminal
    useEffect(() => {
        xtermInstanceRef.current = terminalLogsData.xtermInstance;
    }, [terminalLogsData.xtermInstance]);

    // Clean SSE connection using the hook!
    const logStream = useLogStream({
        terminalRef: xtermInstanceRef,
        autoWriteToTerminal: false, // Don't write to terminal, only to context
        callbacks: {
            onLog: (message, rawText, rawBytes) => {
                if (rawText) {
                    const logText = rawText.replace(/\r?\n$/, '');
                    // ONLY save to context - let the effect above handle terminal writing
                    addTerminalLog(logText);
                }
            },
            onError: (message) => {
                errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Terminal logs error:', message);
                showToast(message, 'error', t.projectDetail.logs.terminal.logsErrorTitle);
            },
            onContainerExit: (exitCode, message) => {
                console.log('Container exited:', exitCode, message);
                containerExitedRef.current = true;
                setStreamStatus("ended");
                setTerminalStreaming(false);
                if (exitCode !== 0) {
                    showToast(message || interpolate(t.projectDetail.logs.terminal.containerExited, { code: String(exitCode) }), 'error', t.projectDetail.logs.terminal.containerStoppedTitle);
                }
            },
        },
        onConnect: () => {
            console.log('Connected to terminal logs stream');
            setStreamStatus("live");
        },
        onDisconnect: () => {
            console.log('Disconnected from terminal logs stream');
            setStreamStatus(containerExitedRef.current ? "ended" : manualStopRef.current ? "stopped" : "failed");
            setTerminalStreaming(false);
        },
        onError: (error) => {
            errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Terminal logs stream error:', error);
            setStreamStatus("failed");
            setTerminalStreaming(false);
            showToast(t.projectDetail.logs.terminal.connectFailed, 'error', t.projectDetail.logs.terminal.connectFailedTitle);
        },
    });

    const connectLiveStream = useCallback(async () => {
        if (!streamTarget) return;
        manualStopRef.current = false;
        containerExitedRef.current = false;
        setStreamStatus("connecting");
        await logStream.connect(appendQueryParam(streamTarget, 'tail', String(LOG_HISTORY_TAIL)));
    }, [streamTarget, logStream]);

    const clearLogs = useCallback(() => {
        clearTerminalLogs();
        lastLogSequenceRef.current = 0;
        setSearchQuery("");
        setHasMatches(false);
        setIsSearching(false);
        searchAddonRef.current?.clearDecorations?.();
        setOlderTerminalRowsDiscarded(false);
        follow.resume();
        effectShows.current = true;
        if (xtermRef.current?.xterm) {
            xtermRef.current.xterm.reset();
        }
    }, [clearTerminalLogs, follow.resume]);

    const toggleStreaming = async () => {
        if (terminalLogsData.isStreaming) {
            // Disconnect using the clean hook
            manualStopRef.current = true;
            logStream.disconnect();

            if (streamIntervalRef.current) {
                clearInterval(streamIntervalRef.current);
                streamIntervalRef.current = null;
            }
            setTerminalStreaming(false);
            setStreamStatus("stopped");
        } else {
            clearLogs();
            setTerminalStreaming(true);
            try {
                if (streamTarget) {
                    await connectLiveStream();
                } else {
                    // Mock stream - add initial message as a log
                    addTerminalLog('[Using Mock Stream - No Project ID]');
                    setStreamStatus("live");

                    streamIntervalRef.current = setInterval(() => {
                        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
                        const newLog = `[${timestamp}] Request processed: ${Math.random().toString(36).substring(7)}`;
                        // ONLY write to context - let effect handle terminal display
                        addTerminalLog(newLog);
                    }, 1500);
                }
            } catch (error) {
                errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Error starting stream:', error);
                setStreamStatus("failed");
                setTerminalStreaming(false);
            }
        }
    };

    useEffect(() => {
        if (!streamTarget) return;

        const wasStreaming = terminalLogsData.isStreaming;

        manualStopRef.current = true;
        logStream.disconnect();
        if (streamIntervalRef.current) {
            clearInterval(streamIntervalRef.current);
            streamIntervalRef.current = null;
        }

        clearLogs();

        if (!wasStreaming) {
            setTerminalStreaming(false);
            setStreamStatus("stopped");
            return;
        }

        manualStopRef.current = false;
        setTerminalStreaming(true);
        void connectLiveStream().catch((error) => {
            errorDiagnostics.error("dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs", 'Error switching log stream:', error);
            setStreamStatus("failed");
            setTerminalStreaming(false);
        });
    }, [streamTarget, connectLiveStream, clearLogs]);

    // Auto-start streaming when terminal is ready
    const autoStarted = useRef(false);
    useEffect(() => {
        if (!terminalReady || !streamTarget || autoStarted.current) return;
        autoStarted.current = true;
        setTerminalStreaming(true);
        void connectLiveStream().catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/projects/[id]/components/logs/TerminalLogs");
            setStreamStatus("failed");
            setTerminalStreaming(false);
        });
    }, [terminalReady, streamTarget, connectLiveStream]);

    const logStreamRef = useRef(logStream);
    useEffect(() => { logStreamRef.current = logStream; });

    useEffect(() => {
        return () => {
            if (streamIntervalRef.current) {
                clearInterval(streamIntervalRef.current);
            }
            manualStopRef.current = true;
            logStreamRef.current.disconnect();
            setTerminalStreaming(false);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Listen for clear logs event
    useEffect(() => {
        const handleClearLogs = () => {
            clearLogs();
        };

        window.addEventListener('clearLogs', handleClearLogs);
        return () => {
            window.removeEventListener('clearLogs', handleClearLogs);
        };
    }, [clearLogs]);

    const isStreamingRef = useRef(false);
    useEffect(() => {
        isStreamingRef.current = terminalLogsData.isStreaming;
    }, [terminalLogsData.isStreaming]);
    
    const writeAnimated = async (term: any, text: any, delay = 5) => {
        for (const char of text) {
            if(isStreamingRef.current) return;
            term.write(char);
            await new Promise(r => setTimeout(r, delay));
        }
    };

    async function showOblienHeader(xtermRef: any) {
        if (effectShows.current) return;
        const term = xtermRef.current.xterm;
        const fitAddon = xtermRef.current.fitAddon;
      
        if (fitAddon) fitAddon.fit();
        term.reset();
        effectShows.current = true;
      }

    const terminalCopy = t.projectDetail.logs.terminal;
    const statusLabel = {
        connecting: terminalCopy.connecting,
        live: terminalCopy.live,
        stopped: terminalCopy.stopped,
        ended: terminalCopy.ended,
        failed: terminalCopy.failed,
    }[streamStatus];

    return (
        <TerminalCardShell
            name={projectName || t.projectDetail.logs.terminal.fallbackName}
            title={title}
            toolbar={
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 basis-56">
                        <TerminalSearch
                            value={searchQuery}
                            onChange={setSearchQuery}
                            onNext={handleSearchNext}
                            onPrevious={handleSearchPrevious}
                            hasMatches={hasMatches}
                            searching={isSearching}
                            disabled={!terminalReady}
                        />
                    </div>
                    <TerminalFollowControls
                        isFollowing={follow.isFollowing}
                        onToggle={follow.toggle}
                        onJumpToLatest={follow.resume}
                    />
                </div>
            }
            status={
                <>
                    <div className="flex items-center gap-2">
                        <div className={`h-2 w-2 rounded-full ${streamStatus === "live" ? "bg-success-solid animate-pulse" : streamStatus === "failed" ? "bg-danger" : "bg-muted-foreground/40"}`}></div>
                        <span className="text-xs text-muted-foreground hidden sm:inline">{statusLabel}</span>
                        <span className="text-xs text-muted-foreground font-mono hidden md:inline">{interpolate(terminalCopy.entries, { count: String(terminalLogsData.logs.length) })}</span>
                    </div>

                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={toggleStreaming}
                        aria-label={terminalLogsData.isStreaming ? t.projectDetail.logs.terminal.stop : t.projectDetail.logs.terminal.start}
                        className={`h-9 ${terminalLogsData.isStreaming
                            ? 'bg-danger-bg text-danger hover:bg-danger-bg hover:text-danger'
                            : 'bg-success-bg text-success hover:bg-success-bg hover:text-success'
                            }`}
                    >
                        {terminalLogsData.isStreaming ? (
                            <>
                                <UiIcon name="pause" className="w-3.5 h-3.5" />
                                <span>{t.projectDetail.logs.terminal.stop}</span>
                            </>
                        ) : (
                            <>
                                <UiIcon name="play" className="w-3.5 h-3.5" />
                                <span>{t.projectDetail.logs.terminal.start}</span>
                            </>
                        )}
                    </Button>
                </>
            }
            overlay={
                terminalLogsData.logs.length === 0 ? (
                    <p className="text-sm text-muted-foreground/50">
                        {{
                            stopped: terminalCopy.pressStart,
                            connecting: terminalCopy.waitingForLogs,
                            live: terminalCopy.waitingForLogs,
                            ended: terminalCopy.ended,
                            failed: terminalCopy.failed,
                        }[streamStatus]}
                    </p>
                ) : undefined
            }
            notice={
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-3 text-xs text-muted-foreground">
                    <span>{interpolate(terminalCopy.renderedRows, { count: LOG_SCROLLBACK_ROWS.toLocaleString() })}</span>
                    {olderTerminalRowsDiscarded && (
                        <span role="status">{terminalCopy.olderOutputDiscarded}</span>
                    )}
                    {terminalLogsData.droppedLogs > 0 && (
                        <span role="status">{terminalCopy.olderEntriesDiscarded}</span>
                    )}
                </div>
            }
            className="min-h-[clamp(440px,65vh,760px)]"
        >
            <div ref={terminalRef} className="w-full h-full" />
        </TerminalCardShell>
    );
};
