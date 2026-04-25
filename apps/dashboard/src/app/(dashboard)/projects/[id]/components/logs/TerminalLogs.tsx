"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, Terminal as TerminalIcon, Search, X, ChevronUp, ChevronDown } from "lucide-react";
import '@xterm/xterm/css/xterm.css';
import './logs.css';
import { useLogStream } from "@/hooks/useSSEConnection";

import { useToast } from "@/context/ToastContext";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useTheme } from "@/components/theme-provider";
import { api } from "@/lib/api";

interface TerminalLogsProps {
    projectId: string;
    projectName: string;
    streamTarget: string;
    historyTarget: string;
    onLogsChange: (logs: string[]) => void;
}

const appendQueryParam = (target: string, key: string, value: string) => {
    if (!target) return target;
    const separator = target.includes('?') ? '&' : '?';
    return `${target}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

const decodeLogEntry = (entry: any): string | null => {
    if (!entry || typeof entry !== 'object') return null;

    if (typeof entry.rawData === 'string' && entry.rawData) {
        try {
            const binary = atob(entry.rawData);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder().decode(bytes).replace(/\r?\n$/, '');
        } catch {
            // Fall through to message below.
        }
    }

    if (typeof entry.message === 'string') {
        return entry.message.replace(/\r?\n$/, '');
    }

    return null;
};

export const TerminalLogs: React.FC<TerminalLogsProps> = ({
    projectId,
    projectName,
    streamTarget,
    historyTarget,
    onLogsChange,
}) => {
    const { showToast } = useToast();
    const {
        terminalLogsData,
        addTerminalLog,
        clearTerminalLogs,
        setTerminalStreaming,
        setTerminalXtermInstance
    } = useProjectSettings();

    const { resolvedTheme } = useTheme();
    const isDarkMode = resolvedTheme === "dark";

    const [searchQuery, setSearchQuery] = useState("");
    const [hasMatches, setHasMatches] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [terminalReady, setTerminalReady] = useState(false);
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<any>(null);
    const searchAddonRef = useRef<any>(null);
    const streamIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const lastLogIndexRef = useRef(0); // Track last written log index to prevent duplicates
    const terminalLogCountRef = useRef(0);
    const effectShows = useRef(false);
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
            scrollback: 10000,
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
                    showToast('Copied to clipboard', 'success');
                }).catch(err => {
                    console.error('Failed to copy text:', err);
                });
            }
        });


        xtermRef.current = { xterm, fitAddon };
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
                console.error('Resize error:', e);
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
            // Reset the index to replay all logs
            lastLogIndexRef.current = 0;

            // Replay all stored logs
            terminalLogsData.logs.forEach((log, index) => {
                if (xtermRef.current?.xterm) {
                    xtermRef.current.xterm.write(log + '\r\n');
                }
            });

            // Update lastLogIndex to current length
            lastLogIndexRef.current = terminalLogsData.logs.length;
        }
    }, [terminalReady]); // Only run when terminal becomes ready

    // Write NEW logs from context to terminal (live updates)
    useEffect(() => {
        if (terminalReady && xtermRef.current?.xterm && terminalLogsData.logs.length > lastLogIndexRef.current) {
            // Write only new logs that haven't been written yet
            const newLogs = terminalLogsData.logs.slice(lastLogIndexRef.current);
            newLogs.forEach(log => {
                if (xtermRef.current?.xterm) {
                    try {
                        xtermRef.current.xterm.write(log + '\r\n');
                    } catch (err) {
                        console.error('Error writing log to terminal:', err);
                    }
                }
            });

            // Update the index
            lastLogIndexRef.current = terminalLogsData.logs.length;
        }
    }, [terminalLogsData.logs.length, terminalReady]); // Run when new logs arrive

    // Update terminal theme when global theme changes
    useEffect(() => {
        if (terminalLogsData.xtermInstance) {
            terminalLogsData.xtermInstance.options.theme = getTerminalTheme();
        }
    }, [resolvedTheme]);

    useEffect(() => {
        onLogsChange(terminalLogsData.logs);
    }, [terminalLogsData.logs, onLogsChange]);

    useEffect(() => {
        terminalLogCountRef.current = terminalLogsData.logs.length;
    }, [terminalLogsData.logs.length]);

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
        } catch (error) {
            console.warn('Search addon error:', error);
            setHasMatches(false);
        }
    }, []);

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
            searchAddonRef.current.findNext(searchQuery, {
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
        } catch (error) {
            console.warn('Search next error:', error);
        }
    };

    const handleSearchPrevious = () => {
        if (!searchAddonRef.current || !searchQuery || !hasMatches) return;
        try {
            // Navigate to previous match with decorations
            searchAddonRef.current.findPrevious(searchQuery, {
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
        } catch (error) {
            console.warn('Search previous error:', error);
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
                    const logText = rawText.trim();
                    // ONLY save to context - let the effect above handle terminal writing
                    addTerminalLog(logText);
                }
            },
            onError: (message) => {
                console.error('Terminal logs error:', message);
                showToast(message, 'error', 'Logs Error');
            },
            onContainerExit: (exitCode, message) => {
                console.log('Container exited:', exitCode, message);
                setTerminalStreaming(false);
                if (exitCode !== 0) {
                    showToast(message || `Container exited with code ${exitCode}`, 'error', 'Container Stopped');
                }
            },
        },
        onConnect: () => {
            console.log('Connected to terminal logs stream');
        },
        onDisconnect: () => {
            console.log('Disconnected from terminal logs stream');
            setTerminalStreaming(false);
        },
        onError: (error) => {
            console.error('Terminal logs stream error:', error);
            setTerminalStreaming(false);
            showToast('Failed to connect to terminal logs, make sure your project is running', 'error', 'Failed to connect to terminal logs');
        },
    });

    const loadRecentLogs = useCallback(async (force = false) => {
        if (!historyTarget) return;
        if (!force && terminalLogCountRef.current > 0) return;

        try {
            const response = await api.get<{ data?: any[] }>(historyTarget, {
                params: { tail: 100 },
            });
            const entries = Array.isArray(response.data) ? response.data : [];
            for (const entry of entries) {
                const text = decodeLogEntry(entry);
                if (text) addTerminalLog(text);
            }
        } catch (error) {
            console.warn('Failed to load recent terminal logs:', error);
        }
    }, [historyTarget, addTerminalLog]);

    const connectLiveStream = useCallback(async () => {
        if (!streamTarget) return;
        await logStream.connect(appendQueryParam(streamTarget, 'tail', '0'));
    }, [streamTarget, logStream]);

    const toggleStreaming = async () => {
        if (terminalLogsData.isStreaming) {
            // Disconnect using the clean hook
            logStream.disconnect();

            if (streamIntervalRef.current) {
                clearInterval(streamIntervalRef.current);
                streamIntervalRef.current = null;
            }
            setTerminalStreaming(false);
        } else {
            clearLogs();
            setTerminalStreaming(true);
            try {
                if (streamTarget) {
                    await loadRecentLogs(true);
                    await connectLiveStream();
                } else {
                    // Mock stream - add initial message as a log
                    addTerminalLog('[Using Mock Stream - No Project ID]');

                    streamIntervalRef.current = setInterval(() => {
                        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
                        const newLog = `[${timestamp}] Request processed: ${Math.random().toString(36).substring(7)}`;
                        // ONLY write to context - let effect handle terminal display
                        addTerminalLog(newLog);
                    }, 1500);
                }
            } catch (error) {
                console.error('Error starting stream:', error);
                setTerminalStreaming(false);
            }
        }
    };

    useEffect(() => {
        if (!streamTarget) return;

        const wasStreaming = terminalLogsData.isStreaming;

        logStream.disconnect();
        if (streamIntervalRef.current) {
            clearInterval(streamIntervalRef.current);
            streamIntervalRef.current = null;
        }

        clearTerminalLogs();
        lastLogIndexRef.current = 0;
        if (xtermRef.current?.xterm) {
            xtermRef.current.xterm.reset();
        }

        if (!wasStreaming) {
            setTerminalStreaming(false);
            return;
        }

        setTerminalStreaming(true);
        void (async () => {
            await loadRecentLogs(true);
            await connectLiveStream();
        })().catch((error) => {
            console.error('Error switching log stream:', error);
            setTerminalStreaming(false);
        });
    }, [streamTarget, loadRecentLogs, connectLiveStream]);

    // Auto-start streaming when terminal is ready
    const autoStarted = useRef(false);
    useEffect(() => {
        if (!terminalReady || !streamTarget || autoStarted.current) return;
        autoStarted.current = true;
        setTerminalStreaming(true);
        void (async () => {
            await loadRecentLogs();
            await connectLiveStream();
        })().catch(() => {
            setTerminalStreaming(false);
        });
    }, [terminalReady, streamTarget, loadRecentLogs, connectLiveStream]);

    const logStreamRef = useRef(logStream);
    useEffect(() => { logStreamRef.current = logStream; });

    useEffect(() => {
        return () => {
            if (streamIntervalRef.current) {
                clearInterval(streamIntervalRef.current);
            }
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
    }, []);

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

    const clearLogs = () => {
        clearTerminalLogs();
        // Reset the log index counter
        lastLogIndexRef.current = 0;
        terminalLogCountRef.current = 0;
        effectShows.current = true;
        if (xtermRef.current?.xterm) {
            // Clear the terminal display first
            xtermRef.current.xterm.reset();
            // showOblienHeader(xtermRef);
        }
    };

    return (
        <div className="flex flex-col h-full min-h-[460px]">
            {/* Terminal with Frame */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="bg-card rounded-2xl overflow-hidden border border-border/50 flex-1 flex flex-col min-h-0">
                    {/* Terminal Header */}
                    <div className="px-5 py-3 border-b border-border/50">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="flex gap-2">
                                    <div className="w-3 h-3 rounded-full bg-gradient-to-br from-red-400 to-red-500 shadow-sm"></div>
                                    <div className="w-3 h-3 rounded-full bg-gradient-to-br from-yellow-400 to-yellow-500 shadow-sm"></div>
                                    <div className="w-3 h-3 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 shadow-sm"></div>
                                </div>
                                <TerminalIcon className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground/80">{projectName || 'Terminal'}</span>
                            </div>

                            {/* Search Input */}
                            <div className="flex-1 max-w-md">
                                <div className="flex items-center gap-2">
                                    <div className="relative flex-1">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/70" />
                                        <input
                                            type="text"
                                            placeholder="Search in logs..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    if (e.shiftKey) {
                                                        handleSearchPrevious();
                                                    } else {
                                                        handleSearchNext();
                                                    }
                                                }
                                            }}
                                            className="w-full pl-9 pr-8 py-1.5 bg-muted border-border text-foreground placeholder:text-muted-foreground/70 focus:bg-card border rounded-lg text-xs focus:outline-none transition-all"
                                        />
                                        {searchQuery && (
                                            <button
                                                onClick={() => {
                                                    setSearchQuery("");
                                                    setHasMatches(false);
                                                }}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                                            >
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>

                                    {searchQuery && (
                                        <>
                                            {/* Navigation Arrows */}
                                            <div className="flex items-center gap-1">
                                                <button
                                                    onClick={handleSearchPrevious}
                                                    disabled={!hasMatches || isSearching}
                                                    className="p-1 bg-muted hover:bg-muted/80 border-border disabled:opacity-30 disabled:cursor-not-allowed rounded border transition-colors"
                                                    title="Previous match (Shift+Enter)"
                                                >
                                                    <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                                                </button>
                                                <button
                                                    onClick={handleSearchNext}
                                                    disabled={!hasMatches || isSearching}
                                                    className="p-1 bg-muted hover:bg-muted/80 border-border disabled:opacity-30 disabled:cursor-not-allowed rounded border transition-colors"
                                                    title="Next match (Enter)"
                                                >
                                                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center gap-2 sm:gap-3">
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${terminalLogsData.isStreaming ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30'}`}></div>
                                    <span className="text-xs text-muted-foreground font-mono hidden sm:inline">{terminalLogsData.logs.length} lines</span>
                                </div>

                                <button
                                    onClick={toggleStreaming}
                                    className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg font-medium text-xs transition-all ${terminalLogsData.isStreaming
                                        ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30'
                                        : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30'
                                        }`}
                                >
                                    {terminalLogsData.isStreaming ? (
                                        <>
                                            <Pause className="w-3.5 h-3.5" />
                                            <span className="hidden sm:inline">Stop</span>
                                        </>
                                    ) : (
                                        <>
                                            <Play className="w-3.5 h-3.5" />
                                            <span className="hidden sm:inline">Start</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Terminal Body */}
                    <div className="relative flex-1 p-4 min-h-0">
                        <div ref={terminalRef} className="w-full h-full" />
                        {terminalLogsData.logs.length === 0 && (
                            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                                <p className="text-sm text-muted-foreground/50">
                                    {terminalLogsData.isStreaming ? 'Waiting for logs…' : 'Press Start to begin streaming logs'}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

        </div>
    );
};
