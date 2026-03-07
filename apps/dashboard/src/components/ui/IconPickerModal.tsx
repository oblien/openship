"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Loader2, X } from 'lucide-react';
import { iconsApi } from '@/lib/api';
import generateIcon from '@/utils/icons';

interface IconResult {
    url: string;
    filename: string;
    name?: string;
}

interface IconPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectIcon: (filename: string) => void;
    currentIcon?: string;
    title?: string;
}

export function IconPickerModal({
    isOpen,
    onClose,
    onSelectIcon,
    currentIcon,
    title = "Choose Icon"
}: IconPickerModalProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [icons, setIcons] = useState<IconResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [selectedIcon, setSelectedIcon] = useState<string | null>(currentIcon || null);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [total, setTotal] = useState(0);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const isLoadingMoreRef = useRef(false);

    // Debounced search
    useEffect(() => {
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (!searchTerm.trim()) {
            setIcons([]);
            setOffset(0);
            setHasMore(false);
            setTotal(0);
            return;
        }

        searchTimeoutRef.current = setTimeout(() => {
            searchIcons(false);
        }, 500);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchTerm]);

    // Reset selected icon when modal opens
    useEffect(() => {
        if (isOpen) {
            setSelectedIcon(currentIcon || null);
        }
    }, [isOpen, currentIcon]);

    const searchIcons = async (append = false) => {
        if (isSearching) return;

        const query = searchTerm.trim();
        if (!query) return;

        setIsSearching(true);

        try {
            const currentOffset = append ? offset : 0;
            const response = await iconsApi.search(query, currentOffset, append ? 50 : 100);

            if (response && response.results) {
                const results = Array.isArray(response.results)
                    ? response.results
                    : Object.values(response.results);

                if (append) {
                    setIcons(prev => [...prev, ...results]);
                } else {
                    setIcons(results);
                }

                setOffset(response.offset || 0);
                setHasMore(response.hasMore || false);
                setTotal(response.total || 0);
            }
        } catch (error) {
            console.error('Error searching icons:', error);
        } finally {
            setIsSearching(false);
            isLoadingMoreRef.current = false;
        }
    };

    const handleScroll = useCallback(() => {
        if (!scrollContainerRef.current || isLoadingMoreRef.current || !hasMore || isSearching) {
            return;
        }

        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;

        if (scrollHeight - scrollTop <= clientHeight + 300) {
            isLoadingMoreRef.current = true;
            searchIcons(true);
        }
    }, [hasMore, isSearching, offset]);

    const handleSelectIcon = (filename: string) => {
        setSelectedIcon(filename);
    };

    const handleConfirm = () => {
        if (selectedIcon) {
            onSelectIcon(selectedIcon);
            onClose();
        }
    };

    const handleClose = () => {
        setSearchTerm('');
        setIcons([]);
        setOffset(0);
        setHasMore(false);
        setTotal(0);
        onClose();
    };

    return (
        <div className="flex flex-col h-full min-h-[30rem]">
            {/* Header */}
            <div className="px-6 py-4 border-b border-border/50 flex-shrink-0">
                <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                    </div>

                    {/* Search Box - inline with header */}
                    <div className="flex-1 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Search icons..."
                            className="w-full pl-9 pr-4 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none transition-all"
                            autoFocus
                        />
                    </div>

                    <div className="flex items-center gap-3">
                        {total > 0 && (
                            <p className="text-xs text-muted-foreground whitespace-nowrap">
                                {offset} of {total}
                            </p>
                        )}
                        <button
                            onClick={handleClose}
                            className="p-1.5 rounded-xl bg-card hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Icons Grid */}
            <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto min-h-0 relative"
            >
                {!searchTerm.trim() ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
                        <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center mb-3">
                            <Search className="w-8 h-8 text-muted-foreground" />
                        </div>
                        <h3 className="text-base font-medium text-muted-foreground mb-1">Start Searching</h3>
                        <p className="text-sm text-muted-foreground">Enter a keyword to find icons</p>
                    </div>
                ) : isSearching && icons.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6">
                        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin mb-3" />
                        <p className="text-sm text-muted-foreground">Searching for icons...</p>
                    </div>
                ) : icons.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
                        <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center mb-3">
                            <Search className="w-8 h-8 text-muted-foreground" />
                        </div>
                        <h3 className="text-base font-medium text-muted-foreground mb-1">No Icons Found</h3>
                        <p className="text-sm text-muted-foreground">Try a different search term</p>
                    </div>
                ) : (
                    <div className="p-6">
                        <div className="flex flex-wrap gap-3 justify-between">
                            {icons.map((icon, index) => {
                                const filename = icon.filename || icon.url.split('/').pop() || '';
                                const isSelected = selectedIcon === filename;

                                return (
                                    <button
                                        key={`${filename}-${index}`}
                                        onClick={() => handleSelectIcon(filename)}
                                        className={`flex w-16 h-16 flex-col items-center justify-center p-3 rounded-lg transition-all group ${isSelected
                                                ? 'bg-primary text-primary-foreground ring-2 ring-primary'
                                                : ''
                                            }`}
                                    >
                                        <div className={`w-16 h-16 rounded-lg flex items-center justify-center  transition-all ${isSelected
                                                ? ''
                                                : 'group-hover:scale-105'
                                            }`}>
                                            <div className="scale-[0.75]">
                                                {generateIcon(filename, 40, isSelected ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))')}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Loading More Indicator */}
                        {isSearching && icons.length > 0 && (
                            <div className="flex justify-center items-center py-6">
                                <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                                <span className="ml-2 text-xs text-muted-foreground">Loading more...</span>
                            </div>
                        )}

                        {/* No More Results */}
                        {!hasMore && icons.length > 0 && (
                            <div className="text-center py-6">
                                <p className="text-xs text-muted-foreground">No more results</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-border/50 flex gap-3 flex-shrink-0">
                <button
                    onClick={handleClose}
                    className="flex-1 px-4 py-3 text-sm font-medium text-foreground bg-muted hover:bg-muted/80 rounded-xl transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleConfirm}
                    disabled={!selectedIcon}
                    className="flex-1 px-4 py-3 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {selectedIcon ? 'Select Icon' : 'Choose an icon'}
                </button>
            </div>
        </div>
    );
}


export default IconPickerModal;