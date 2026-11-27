import {
  ArrowLeft,
  ArrowRight,
  Calendar as CalendarIcon,
  Clock,
  FileText,
  Filter,
  Hash,
  Info,
  Loader2,
  Mail,
  Paperclip,
  Search,
  Star,
  Tag,
  Trash2,
  User,
  Users,
  X as XIcon,
} from 'lucide-react';
import {
  createContext,
  Fragment,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { getMainSearchTerm, parseNaturalLanguageSearch } from '@/lib/utils';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useSearchValue } from '@/hooks/use-search-value';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocation, useNavigate } from 'react-router';
import { navigationConfig } from '@/config/navigation';
import { Separator } from '@/components/ui/separator';
import { useTRPC } from '@/providers/query-provider';
import { useMailAssistantAvailability } from '@/hooks/use-mail-assistant';
import { Calendar } from '@/components/ui/calendar';
import { useMutation } from '@tanstack/react-query';
import { useThreads } from '@/hooks/use-threads';
import { useLabels } from '@/hooks/use-labels';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { format, subDays } from 'date-fns';
import { VisuallyHidden } from 'radix-ui';
import { m } from '@/paraglide/messages';
import { Pencil2 } from '../icons/icons';
import { Button } from '../ui/button';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';

type CommandPaletteContext = {
  activeFilters: ActiveFilter[];
  clearAllFilters: () => void;
};

interface CommandItem {
  title: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  url?: string;
  onClick?: () => unknown;
  shortcut?: string;
  isBackButton?: boolean;
  disabled?: boolean;
  keywords?: string[];
  description?: string;
}

interface FilterOption {
  id: string;
  name: string;
  keywords: string[];
  action: (...args: string[]) => string;
  requiresInput?: boolean;
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

interface SavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: Date;
}

interface ActiveFilter {
  id: string;
  type: string;
  value: string;
  display: string;
}

type CommandView =
  | 'main'
  | 'search'
  | 'filter'
  | 'dateRange'
  | 'labels'
  | 'savedSearches'
  | 'filterBuilder'
  | 'help';

const CommandPaletteContext = createContext<CommandPaletteContext | null>(null);

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error('useCommandPalette must be used within a CommandPaletteProvider.');
  }
  return context;
}

const RECENT_SEARCHES_KEY = 'mail-recent-searches';
const SAVED_SEARCHES_KEY = 'mail-saved-searches';
const ACTIVE_FILTERS_KEY = 'mail-active-filters';

const getRecentSearches = (): string[] => {
  try {
    const searches = localStorage.getItem(RECENT_SEARCHES_KEY);
    return searches ? JSON.parse(searches) : [];
  } catch {
    return [];
  }
};

const saveRecentSearch = (search: string) => {
  try {
    const searches = getRecentSearches();
    const updated = [search, ...searches.filter((s) => s !== search)].slice(0, 10);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save recent search:', error);
  }
};

const getSavedSearches = (): SavedSearch[] => {
  try {
    const searches = localStorage.getItem(SAVED_SEARCHES_KEY);
    return searches ? JSON.parse(searches) : [];
  } catch {
    return [];
  }
};

const saveSavedSearch = (search: SavedSearch) => {
  try {
    const searches = getSavedSearches();
    const updated = [search, ...searches];
    localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save search:', error);
  }
};

const deleteSavedSearch = (id: string) => {
  try {
    const searches = getSavedSearches();
    const updated = searches.filter((s) => s.id !== id);
    localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to delete saved search:', error);
  }
};

export function CommandPalette({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useQueryState('isCommandPaletteOpen');
  const [, setIsComposeOpen] = useQueryState('isComposeOpen');
  const [currentView, setCurrentView] = useState<CommandView>('main');
  const [selectedDateFilter, setSelectedDateFilter] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [dateRangeStart, setDateRangeStart] = useState<Date | undefined>(undefined);
  const [dateRangeEnd, setDateRangeEnd] = useState<Date | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchValue, setSearchValue] = useSearchValue();
  const [, threads] = useThreads();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  //   const [selectedLabels] = useState<string[]>([]);
  const [filterBuilderState, setFilterBuilderState] = useState<Record<string, string>>({});
  const [saveSearchName, setSaveSearchName] = useState('');
  const [emailSuggestions, setEmailSuggestions] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [commandInputValue, setCommandInputValue] = useState('');
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const { userLabels = [] } = useLabels();
  const trpc = useTRPC();
  const smartSearch = !!useMailAssistantAvailability()?.enabled;
  const { mutateAsync: generateSearchQuery } = useMutation(
    trpc.ai.generateSearchQuery.mutationOptions(),
  );

  useEffect(() => {
    setRecentSearches(getRecentSearches());
    setSavedSearches(getSavedSearches());

    try {
      const saved = localStorage.getItem(ACTIVE_FILTERS_KEY);
      if (saved) {
        const filters = JSON.parse(saved);
        setActiveFilters(filters);
        const query = filters.map((f: ActiveFilter) => f.value).join(' ');
        if (query) {
          setSearchValue({
            ...searchValue,
            value: query,
            highlight: getMainSearchTerm(query),
          });
        }
      }
    } catch (error) {
      console.error('Failed to load active filters:', error);
    }
  }, []);

  useEffect(() => {
    if (threads && Array.isArray(threads)) {
      const emails = new Set<string>();
      threads.forEach((thread: any) => {
        if (thread?.from?.email) emails.add(thread.from.email);
        if (thread?.to && Array.isArray(thread.to)) {
          thread.to.forEach((recipient: any) => {
            if (recipient?.email) emails.add(recipient.email);
          });
        }
      });
      setEmailSuggestions(Array.from(emails).slice(0, 20));
    }
  }, [threads]);

  useEffect(() => {
    if (!open) {
      setCurrentView('main');
      setSearchQuery('');
      setSaveSearchName('');
      setFilterBuilderState({});
      setCommandInputValue('');
    }
  }, [open]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prevOpen) => (prevOpen ? null : 'true'));
      }

      if (open) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          setCurrentView('filter');
        }

        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          setCurrentView('search');
        }

        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          setCurrentView('labels');
        }

        if (e.key === 'Escape' && currentView !== 'main') {
          e.preventDefault();
          setCurrentView('main');
        }
      }
    };

    document.addEventListener('keydown', down, { capture: true });
    return () => document.removeEventListener('keydown', down, { capture: true });
  }, [open, currentView]);

  const runCommand = useCallback((command: () => unknown) => {
    setOpen(null);
    command();
  }, []);

  const filterOptions = useMemo<FilterOption[]>(
    () => [
      {
        id: 'from',
        name: 'From',
        keywords: ['sender', 'from', 'author', 'sent by'],
        action: (currentSearch: string) => `from:${currentSearch}`,
        requiresInput: true,
        icon: User,
      },
      {
        id: 'to',
        name: 'To',
        keywords: ['recipient', 'to', 'receiver', 'sent to'],
        action: (currentSearch: string) => `to:${currentSearch}`,
        requiresInput: true,
        icon: Users,
      },
      {
        id: 'subject',
        name: 'Subject',
        keywords: ['title', 'subject', 'about', 'regarding'],
        action: (currentSearch: string) => `subject:"${currentSearch}"`,
        requiresInput: true,
        icon: FileText,
      },
      {
        id: 'has:attachment',
        name: 'Has Attachment',
        keywords: ['attachment', 'file', 'document', 'attached'],
        action: () => 'has:attachment',
        icon: Paperclip,
      },
      {
        id: 'is:starred',
        name: 'Is Starred',
        keywords: ['starred', 'favorite', 'important', 'star'],
        action: () => 'is:starred',
        icon: Star,
      },
      {
        id: 'is:unread',
        name: 'Is Unread',
        keywords: ['unread', 'new', 'unopened', 'not read'],
        action: () => 'is:unread',
        icon: Mail,
      },
      {
        id: 'after',
        name: 'After Date',
        keywords: ['date', 'after', 'since', 'newer than'],
        action: (currentSearch: string) => `after:${currentSearch}`,
        requiresInput: true,
        icon: CalendarIcon,
      },
      {
        id: 'before',
        name: 'Before Date',
        keywords: ['date', 'before', 'until', 'older than'],
        action: (currentSearch: string) => `before:${currentSearch}`,
        requiresInput: true,
        icon: CalendarIcon,
      },
      {
        id: 'between',
        name: 'Date Range',
        keywords: ['between', 'date range', 'from to', 'period'],
        action: (...args: string[]) => `after:${args[0]} before:${args[1]}`,
        requiresInput: true,
        icon: CalendarIcon,
      },
      {
        id: 'has:label',
        name: 'Has Label',
        keywords: ['label', 'tag', 'category', 'labeled'],
        action: (currentSearch: string) => `label:${currentSearch}`,
        requiresInput: true,
        icon: Tag,
      },
    ],
    [],
  );

  const addFilter = useCallback((filter: ActiveFilter) => {
    setActiveFilters((prev) => {
      const updated = [...prev.filter((f) => f.type !== filter.type), filter];
      try {
        localStorage.setItem(ACTIVE_FILTERS_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error('Failed to save filters:', error);
      }
      return updated;
    });
  }, []);

  const removeFilter = useCallback((filterId: string) => {
    setActiveFilters((prev) => {
      const updated = prev.filter((f) => f.id !== filterId);
      try {
        localStorage.setItem(ACTIVE_FILTERS_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error('Failed to save filters:', error);
      }
      return updated;
    });
  }, []);

  useEffect(() => {
    if (pathname && activeFilters.length) {
      clearAllFilters();
    }
  }, [pathname]);

  const clearAllFilters = useCallback(() => {
    setActiveFilters([]);
    try {
      localStorage.removeItem(ACTIVE_FILTERS_KEY);
    } catch (error) {
      console.error('Failed to clear filters:', error);
    }
    setSearchValue({
      value: '',
      highlight: '',
      folder: searchValue.folder,
      isAISearching: false,
    });
  }, [searchValue.folder, setSearchValue]);

  const executeSearch = useCallback(
    (query: string, isNaturalLanguage = false) => {
      setOpen(null);

      if (query && query.trim()) {
        saveRecentSearch(query);
        setRecentSearches(getRecentSearches());
      }

      let finalQuery = query;

      if (isNaturalLanguage) {
        const semanticQuery = parseNaturalLanguageSearch(query);
        finalQuery = semanticQuery || query;
      }

      const isFilterSyntax = /^(from:|to:|subject:|has:|is:|after:|before:|label:)/.test(
        query.trim(),
      );
      if (query.trim() && !isFilterSyntax) {
        const searchFilter: ActiveFilter = {
          id: `search-${Date.now()}`,
          type: 'search',
          value: query,
          display: `Search: "${query}"`,
        };
        addFilter(searchFilter);
      }

      const filterQuery = activeFilters.map((f) => f.value).join(' ');
      if (filterQuery) {
        finalQuery = `${finalQuery} ${filterQuery}`.trim();
      }

      setSearchValue({
        value: finalQuery,
        highlight: getMainSearchTerm(finalQuery),
        folder: searchValue.folder,
        isAISearching: isNaturalLanguage,
      });

      console.warn('Search applied', {
        description: finalQuery,
      });
    },
    [activeFilters, searchValue.folder, setSearchValue, addFilter],
  );

  const quickFilterOptions = useMemo(
    () => [
      {
        title: 'Unread Emails',
        icon: Mail,
        onClick: () => {
          const filter: ActiveFilter = {
            id: 'quick-unread',
            type: 'status',
            value: 'is:unread',
            display: 'Unread',
          };
          addFilter(filter);
          executeSearch('is:unread');
        },
      },
      {
        title: 'Starred Emails',
        icon: Star,
        onClick: () => {
          const filter: ActiveFilter = {
            id: 'quick-starred',
            type: 'status',
            value: 'is:starred',
            display: 'Starred',
          };
          addFilter(filter);
          executeSearch('is:starred');
        },
      },
      {
        title: 'With Attachments',
        icon: Paperclip,
        onClick: () => {
          const filter: ActiveFilter = {
            id: 'quick-attachment',
            type: 'attachment',
            value: 'has:attachment',
            display: 'Has Attachment',
          };
          addFilter(filter);
          executeSearch('has:attachment');
        },
      },
      {
        title: 'Last 7 Days',
        icon: Clock,
        onClick: () => {
          const date = format(subDays(new Date(), 7), 'yyyy/MM/dd');
          const filter: ActiveFilter = {
            id: 'quick-recent',
            type: 'date',
            value: `after:${date}`,
            display: 'Last 7 days',
          };
          addFilter(filter);
          executeSearch(`after:${date}`);
        },
      },
    ],
    [addFilter, executeSearch],
  );

  const handleSearch = useCallback(
    async (query: string, useNaturalLanguage = true) => {
      if (isProcessing) return;
      setIsProcessing(true);

      try {
        let finalQuery = query;

        if (useNaturalLanguage && smartSearch) {
          const result = await generateSearchQuery({ query });
          finalQuery = result.query;

          const searchFilter: ActiveFilter = {
            id: `ai-search-${Date.now()}`,
            type: 'search',
            value: finalQuery,
            display: `AI Search: "${query}"`,
          };
          addFilter(searchFilter);

          setOpen(null);

          return setSearchValue({
            value: finalQuery,
            highlight: getMainSearchTerm(query),
            folder: searchValue.folder,
            isAISearching: useNaturalLanguage,
            isLoading: true,
          });
        }

        const isFilterSyntax = /^(from:|to:|subject:|has:|is:|after:|before:|label:)/.test(
          query.trim(),
        );
        if (query.trim() && !isFilterSyntax) {
          const searchFilter: ActiveFilter = {
            id: `search-${Date.now()}`,
            type: 'search',
            value: query,
            display: `Search: "${query}"`,
          };
          addFilter(searchFilter);
        }

        const filterQuery = activeFilters.map((f) => f.value).join(' ');
        if (filterQuery) {
          finalQuery = `${finalQuery} ${filterQuery}`.trim();
        }

        if (query && query.trim()) {
          saveRecentSearch(query);
          setRecentSearches(getRecentSearches());
        }

        setSearchValue({
          value: finalQuery,
          highlight: getMainSearchTerm(query),
          folder: searchValue.folder,
          isAISearching: false,
          isLoading: true,
        });

        console.warn('Search applied', {
          description: finalQuery,
        });

        setOpen(null);
      } catch (error) {
        console.error('Search error:', error);
        toast.error('Failed to process search');
      } finally {
        setIsProcessing(false);
      }
    },
    [activeFilters, searchValue.folder, isProcessing, smartSearch, generateSearchQuery, addFilter, setOpen, setSearchValue],
  );

  const quickSearchResults = useMemo(() => {
    try {
      if (!searchQuery || searchQuery.length < 2 || !threads) return [];

      const validThreads = Array.isArray(threads) ? threads.filter(Boolean) : [];
      if (validThreads.length === 0) return [];

      return validThreads
        .filter((thread: any) => {
          try {
            if (!thread || typeof thread !== 'object') return false;

            const query = searchQuery.toLowerCase();

            const snippet = thread.snippet?.toString() || '';
            const subject = thread.subject?.toString() || '';
            const fromName = thread.from?.name?.toString() || '';
            const fromEmail = thread.from?.email?.toString() || '';

            return (
              snippet.toLowerCase().includes(query) ||
              subject.toLowerCase().includes(query) ||
              fromName.toLowerCase().includes(query) ||
              fromEmail.toLowerCase().includes(query)
            );
          } catch (err) {
            console.error('Error filtering thread:', err);
            return false;
          }
        })
        .slice(0, 5);
    } catch (error) {
      console.error('Error processing search results:', error);
      return [];
    }
  }, [searchQuery, threads]);

  const allCommands = useMemo(() => {
    type CommandGroup = {
      group: string;
      items: CommandItem[];
    };

    const searchCommands: CommandItem[] = [];
    const mailCommands: CommandItem[] = [];
    const settingsCommands: CommandItem[] = [];
    const otherCommands: Record<string, CommandItem[]> = {};

    mailCommands.push({
      title: 'Compose Email',
      icon: Pencil2,
      shortcut: 'c',
      onClick: () => {
        setIsComposeOpen('true');
      },
    });

    searchCommands.push({
      title: 'Search Emails',
      icon: Search,
      shortcut: 's',
      onClick: () => {
        setCurrentView('search');
      },
      // description: 'Search across your emails',
    });

    searchCommands.push({
      title: 'Filter Emails',
      icon: Filter,
      shortcut: 'f',
      onClick: () => {
        setCurrentView('filter');
      },
      // description: 'Filter emails by criteria',
    });

    // searchCommands.push({
    //   title: 'Saved Searches',
    //   icon: Save,
    //   onClick: () => {
    //     setCurrentView('savedSearches');
    //   },
    //   description: 'View and manage saved searches',
    // });

    // searchCommands.push({
    //   title: 'Filter Builder',
    //   icon: Plus,
    //   onClick: () => {
    //     setCurrentView('filterBuilder');
    //   },
    //   description: 'Build complex filter combinations',
    // });

    quickFilterOptions.forEach((option) => {
      searchCommands.push({
        title: option.title,
        icon: option.icon,
        onClick: option.onClick,
      });
    });

    for (const sectionKey in navigationConfig) {
      const section = navigationConfig[sectionKey];

      section?.sections.forEach((group) => {
        group.items.forEach((navItem) => {
          if (navItem.disabled) return;
          const item: CommandItem = {
            title: navItem.title,
            icon: navItem.icon,
            url: navItem.url,
            shortcut: navItem.shortcut,
            isBackButton: navItem.isBackButton,
            disabled: navItem.disabled,
          };

          if (sectionKey === 'mail') {
            mailCommands.push(item);
          } else if (sectionKey === 'settings') {
            if (!item.isBackButton || pathname.startsWith('/settings')) {
              settingsCommands.push(item);
            }
          } else {
            if (!otherCommands[sectionKey]) {
              otherCommands[sectionKey] = [];
            }
            otherCommands[sectionKey].push(item);
          }
        });
      });
    }

    const result: CommandGroup[] = [
      {
        group: 'Search',
        items: searchCommands,
      },
      {
        group: 'Mail',
        items: mailCommands,
      },
      {
        group: 'Settings',
        items: settingsCommands,
      },
    ];

    Object.entries(otherCommands).forEach(([groupKey, items]) => {
      if (items.length > 0) {
        let groupTitle = groupKey;
        try {
          const translationKey = `common.commandPalette.groups.${groupKey}` as any;
          groupTitle = (m as any)[translationKey]() || groupKey;
        } catch {}

        result.push({
          group: groupTitle,
          items,
        });
      }
    });

    return result;
  }, [pathname, setIsComposeOpen, quickFilterOptions]);

  const hasMatchingCommands = useMemo(() => {
    if (!commandInputValue.trim()) return true;

    const searchTerm = commandInputValue.toLowerCase();

    return allCommands.some((group) =>
      group.items.some(
        (item) =>
          item.title.toLowerCase().includes(searchTerm) ||
          (item.description && item.description.toLowerCase().includes(searchTerm)) ||
          (item.keywords &&
            item.keywords.some((keyword) => keyword.toLowerCase().includes(searchTerm))),
      ),
    );
  }, [commandInputValue, allCommands]);

  const renderMainView = () => (
    <>
      {activeFilters.length > 0 && (
        <div className="border-b px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Active Filters</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-6 px-2 text-xs"
              onClick={clearAllFilters}
            >
              Clear All
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {activeFilters.map((filter) => (
              <Badge key={filter.id} variant="secondary" className="pr-1 text-xs">
                {filter.display}
                <button
                  onClick={() => removeFilter(filter.id)}
                  className="hover:text-destructive ml-1"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}

      <CommandInput
        autoFocus
        placeholder="Type a command or search..."
        value={commandInputValue}
        onValueChange={setCommandInputValue}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && commandInputValue.trim() && !hasMatchingCommands) {
            e.preventDefault();
            handleSearch(commandInputValue, true);
          }
        }}
      />
      <Separator />
      <CommandList>
        <CommandEmpty>
          {isProcessing ? (
            <Loader2 className="m-auto h-4 w-4 animate-spin" />
          ) : (
            <>
              No results found, press <span className="font-bold">ENTER</span> to search for emails
              in this folder
            </>
          )}
        </CommandEmpty>
        {allCommands.map((group, groupIndex) => (
          <Fragment key={group.group}>
            {group.items.length > 0 && (
              <CommandGroup heading={group.group}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.url || item.title}
                    onSelect={() => {
                      if (
                        [
                          'Search Emails',
                          'Filter Emails',
                          'Saved Searches',
                          'Filter Builder',
                        ].includes(item.title)
                      ) {
                        if (item.onClick) {
                          item.onClick();
                          return false;
                        }
                      } else {
                        runCommand(() => {
                          if (item.onClick) {
                            item.onClick();
                          } else if (item.url) {
                            navigate(item.url);
                          }
                        });
                      }
                    }}
                  >
                    {item.icon && (
                      <item.icon
                        size={16}
                        strokeWidth={2}
                        className="h-4 w-4 opacity-60"
                        aria-hidden="true"
                      />
                    )}
                    <div className="ml-2 flex flex-1 flex-col">
                      <span>{item.title}</span>
                      {item.description && (
                        <span className="text-muted-foreground text-xs">{item.description}</span>
                      )}
                    </div>
                    {/* {item.shortcut && (
                      <CommandShortcut>
                        {item.shortcut === 'arrowUp'
                          ? '↑'
                          : item.shortcut === 'arrowDown'
                            ? '↓'
                            : item.shortcut}
                      </CommandShortcut>
                    )} */}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {groupIndex < allCommands.length - 1 && group.items.length > 0 && <Separator />}
          </Fragment>
        ))}

        <CommandGroup heading="Help">
          <CommandItem onSelect={() => setCurrentView('help')}>
            <Info className="h-4 w-4 opacity-60" />
            <span className="ml-2">Filter Syntax Help</span>
            {/* <CommandShortcut>?</CommandShortcut> */}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </>
  );

  const renderSearchView = () => {
    return (
      <>
        <div className="flex items-center border-b px-3">
          <button
            className="text-muted-foreground hover:text-foreground relative top-0.5 mr-2"
            onClick={() => setCurrentView('main')}
            disabled={isProcessing}
          >
            ←
          </button>
          <CommandInput
            autoFocus
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Search your emails..."
            className="w-full border-none"
            disabled={isProcessing}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) {
                e.preventDefault();
                handleSearch(searchQuery, true);
              }
            }}
          />
          {isProcessing && (
            <div className="ml-2">
              <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
            </div>
          )}
        </div>
        <CommandList>
          <CommandEmpty>Type to search your emails...</CommandEmpty>

          {recentSearches.length > 0 && !searchQuery && (
            <CommandGroup heading="Recent Searches">
              {recentSearches.map((search, index) => (
                <CommandItem
                  key={`recent-${index}`}
                  onSelect={() => handleSearch(search, true)}
                  disabled={isProcessing}
                >
                  <Clock className="h-4 w-4 opacity-60" />
                  <span className="ml-2">{search}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {quickSearchResults.length > 0 && (
            <CommandGroup heading="Quick Results">
              {quickSearchResults.map((thread: any) => (
                <CommandItem
                  key={thread.id || `thread-${Math.random()}`}
                  onSelect={() => {
                    runCommand(() => {
                      try {
                        if (thread && thread.id) {
                          navigate(`/inbox?threadId=${thread.id}`);
                        }
                      } catch (error) {
                        console.error('Error navigating to thread:', error);
                        toast.error('Failed to open email');
                      }
                    });
                  }}
                  disabled={isProcessing}
                >
                  <Mail className="h-4 w-4 opacity-60" />
                  <div className="ml-2 flex flex-1 flex-col overflow-hidden">
                    <span className="truncate font-medium">{thread.subject || 'No Subject'}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {thread.from?.name || thread.from?.email || 'Unknown sender'} -{' '}
                      {thread.snippet || ''}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {searchQuery && (
            <CommandGroup heading="Search Suggestions">
              <CommandItem onSelect={() => handleSearch(searchQuery, true)} disabled={isProcessing}>
                <Search className="h-4 w-4 opacity-60" />
                <span className="ml-2">Search for "{searchQuery}"</span>
                {smartSearch && <Badge variant="secondary" className="ml-auto text-xs">
                  Smart Search
                </Badge>}
              </CommandItem>

              <CommandItem
                onSelect={() => handleSearch(searchQuery, false)}
                disabled={isProcessing}
              >
                <Search className="relative top-2 h-4 w-4 opacity-60" />
                <span className="ml-2">Exact match: "{searchQuery}"</span>
              </CommandItem>

              {searchQuery.includes('@') && (
                <CommandItem
                  onSelect={() => handleSearch(`from:${searchQuery}`, false)}
                  disabled={isProcessing}
                >
                  <Mail className="h-4 w-4 opacity-60" />
                  <span className="ml-2">From: {searchQuery}</span>
                </CommandItem>
              )}

              <CommandItem
                onSelect={() => handleSearch(`subject:"${searchQuery}"`, false)}
                disabled={isProcessing}
              >
                <FileText className="h-4 w-4 opacity-60" />
                <span className="ml-2">Subject contains: "{searchQuery}"</span>
              </CommandItem>

              <CommandItem
                onSelect={() => handleSearch(`"${searchQuery}"`, false)}
                disabled={isProcessing}
              >
                <Hash className="h-4 w-4 opacity-60" />
                <span className="ml-2">Body contains: "{searchQuery}"</span>
              </CommandItem>
            </CommandGroup>
          )}

          {!searchQuery && smartSearch && (
            <CommandGroup heading="Try Natural Language">
              {[
                'emails from john',
                'emails from last week',
                'unread emails with attachments',
                'emails about meeting',
                'emails from december 2023',
              ].map((example) => (
                <CommandItem
                  key={example}
                  onSelect={() => {
                    setSearchQuery(example);
                    handleSearch(example, true);
                  }}
                  disabled={isProcessing}
                >
                  <ArrowRight className="h-4 w-4 opacity-60" />
                  <span className="text-muted-foreground ml-2 italic">{example}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {/* <CommandSeparator /> */}

          {/* <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() => {
                setCurrentView('filter');
              }}
              disabled={isProcessing}
            >
              <Filter className="h-4 w-4 opacity-60" />
              <span className="ml-2">Add Filters</span>
            </CommandItem>

            <CommandItem
              onSelect={() => {
                setCurrentView('savedSearches');
              }}
              disabled={isProcessing}
            >
              <Save className="h-4 w-4 opacity-60" />
              <span className="ml-2">Save this search</span>
            </CommandItem>
          </CommandGroup> */}
        </CommandList>
      </>
    );
  };

  const renderFilterView = () => {
    return (
      <>
        <div className="flex items-center border-b px-3">
          <button
            className="text-muted-foreground hover:text-foreground ml-2"
            onClick={() => {
              if (selectedDateFilter) {
                setSelectedDateFilter(null);
                setDateRangeStart(undefined);
                setDateRangeEnd(undefined);
              } else {
                setCurrentView('main');
              }
            }}
          >
            <ArrowLeft className="h-4 w-4"/>
          </button>
          <CommandInput
            autoFocus
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Type to filter..."
            className="border-0"
          />
        </div>

        {!selectedDateFilter ? (
          <CommandList>
            {filterOptions.filter(
              (option) =>
                !searchQuery ||
                option.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                option.keywords.some((kw) => kw.toLowerCase().includes(searchQuery.toLowerCase())),
            ).length === 0 ? (
              <CommandEmpty>No filters found</CommandEmpty>
            ) : null}

            {!searchQuery ? (
              <CommandGroup heading="Available Filters">
                {filterOptions.map((filter) => (
                  <CommandItem
                    key={filter.id}
                    onSelect={() => {
                      if (filter.id === 'after' || filter.id === 'before') {
                        setSelectedDateFilter(filter.id);
                        setSelectedDate(undefined);
                        return false;
                      }

                      if (filter.id === 'between') {
                        setSelectedDateFilter('between');
                        setDateRangeStart(undefined);
                        setDateRangeEnd(undefined);
                        return false;
                      }

                      if (filter.id === 'has:label') {
                        setCurrentView('labels');
                        return false;
                      }

                      if (!filter.requiresInput) {
                        const filterValue = filter.action();
                        const activeFilter: ActiveFilter = {
                          id: `filter-${Date.now()}`,
                          type: filter.id,
                          value: filterValue,
                          display: filter.name,
                        };
                        addFilter(activeFilter);
                        executeSearch(filterValue);
                      }
                    }}
                  >
                    {filter.icon && <filter.icon className="h-4 w-4 opacity-60" />}
                    <span className="ml-2">{filter.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <>
                <CommandGroup heading="Matching Filters">
                  {filterOptions
                    .filter(
                      (option) =>
                        option.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        option.keywords.some((kw) =>
                          kw.toLowerCase().includes(searchQuery.toLowerCase()),
                        ),
                    )
                    .map((filter) => (
                      <CommandItem
                        key={filter.id}
                        onSelect={() => {
                          if (filter.id === 'after' || filter.id === 'before') {
                            setSelectedDateFilter(filter.id);
                            setSelectedDate(undefined);
                            return false;
                          }

                          if (filter.id === 'between') {
                            setSelectedDateFilter('between');
                            setDateRangeStart(undefined);
                            setDateRangeEnd(undefined);
                            return false;
                          }

                          if (filter.id === 'has:label') {
                            setCurrentView('labels');
                            return false;
                          }

                          const newQuery = filter.action(searchQuery);
                          const activeFilter: ActiveFilter = {
                            id: `filter-${Date.now()}`,
                            type: filter.id,
                            value: newQuery,
                            display: `${filter.name}: ${searchQuery}`,
                          };
                          addFilter(activeFilter);
                          executeSearch(newQuery);
                        }}
                      >
                        {filter.icon && <filter.icon className="h-4 w-4 opacity-60" />}
                        <span className="ml-2">{filter.name}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>

                <CommandGroup heading="Apply Search Term">
                  {['from', 'to', 'subject'].map((filterId) => {
                    const filter = filterOptions.find((f) => f.id === filterId);
                    if (!filter) return null;
                    return (
                      <CommandItem
                        key={filter.id}
                        onSelect={() => {
                          const newQuery = filter.action(searchQuery);
                          const activeFilter: ActiveFilter = {
                            id: `filter-${Date.now()}`,
                            type: filter.id,
                            value: newQuery,
                            display: `${filter.name}: ${searchQuery}`,
                          };
                          addFilter(activeFilter);
                          executeSearch(newQuery);
                        }}
                      >
                        <Filter className="h-4 w-4 opacity-60" />
                        <span className="ml-2">
                          {filter.name}: <span className="font-medium">{searchQuery}</span>
                        </span>
                      </CommandItem>
                    );
                  })}

                  {['from', 'to'].includes(searchQuery) &&
                    emailSuggestions
                      .filter((email) => email.toLowerCase().includes(searchQuery.toLowerCase()))
                      .slice(0, 5)
                      .map((email) => (
                        <CommandItem
                          key={`suggestion-${email}`}
                          onSelect={() => {
                            const filter = filterOptions.find((f) => f.id === 'from');
                            if (filter) {
                              const newQuery = filter.action(email);
                              const activeFilter: ActiveFilter = {
                                id: `filter-${Date.now()}`,
                                type: 'from',
                                value: newQuery,
                                display: `From: ${email}`,
                              };
                              addFilter(activeFilter);
                              executeSearch(newQuery);
                            }
                          }}
                        >
                          <Mail className="h-4 w-4 opacity-60" />
                          <span className="ml-2 text-xs">{email}</span>
                        </CommandItem>
                      ))}
                </CommandGroup>
              </>
            )}

            <CommandGroup heading="Examples">
              <CommandItem disabled>
                <CalendarIcon className="h-4 w-4 opacity-60" />
                <span className="ml-2">after:2024/01/01</span>
              </CommandItem>
              <CommandItem disabled>
                <Mail className="h-4 w-4 opacity-60" />
                <span className="ml-2">from:john@example.com</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        ) : selectedDateFilter === 'between' ? (
          <div className="px-4 py-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium">Select date range</h3>
              <button
                onClick={() => {
                  setSelectedDateFilter(null);
                  setDateRangeStart(undefined);
                  setDateRangeEnd(undefined);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <Label className="text-xs">Start Date</Label>
                <Calendar
                  mode="single"
                  selected={dateRangeStart}
                  onSelect={(date) => {
                    setDateRangeStart(date);
                    if (date && dateRangeEnd) {
                      const start = format(date, 'yyyy/MM/dd');
                      const end = format(dateRangeEnd, 'yyyy/MM/dd');
                      const filterValue = `after:${start} before:${end}`;
                      const activeFilter: ActiveFilter = {
                        id: `filter-${Date.now()}`,
                        type: 'dateRange',
                        value: filterValue,
                        display: `${format(date, 'MMM d')} - ${format(dateRangeEnd, 'MMM d, yyyy')}`,
                      };
                      addFilter(activeFilter);
                      executeSearch(filterValue);
                    }
                  }}
                  disabled={(date) => (dateRangeEnd ? date > dateRangeEnd : false)}
                  className="rounded-md border"
                />
              </div>
              <div>
                <Label className="text-xs">End Date</Label>
                <Calendar
                  mode="single"
                  selected={dateRangeEnd}
                  onSelect={(date) => {
                    setDateRangeEnd(date);
                    if (dateRangeStart && date) {
                      const start = format(dateRangeStart, 'yyyy/MM/dd');
                      const end = format(date, 'yyyy/MM/dd');
                      const filterValue = `after:${start} before:${end}`;
                      const activeFilter: ActiveFilter = {
                        id: `filter-${Date.now()}`,
                        type: 'dateRange',
                        value: filterValue,
                        display: `${format(dateRangeStart, 'MMM d')} - ${format(date, 'MMM d, yyyy')}`,
                      };
                      addFilter(activeFilter);
                      executeSearch(filterValue);
                    }
                  }}
                  disabled={(date) => (dateRangeStart ? date < dateRangeStart : false)}
                  className="rounded-md border"
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="px-4 py-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {selectedDateFilter === 'after' ? 'Select date (after)' : 'Select date (before)'}
              </h3>
              <button
                onClick={() => setSelectedDateFilter(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-col items-center">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => {
                  setSelectedDate(date);
                  if (date) {
                    const formattedDate = format(date, 'yyyy/MM/dd');
                    const filterAction = selectedDateFilter === 'after' ? 'after:' : 'before:';
                    const filterValue = `${filterAction}${formattedDate}`;
                    const activeFilter: ActiveFilter = {
                      id: `filter-${Date.now()}`,
                      type: selectedDateFilter,
                      value: filterValue,
                      display: `${selectedDateFilter === 'after' ? 'After' : 'Before'} ${format(date, 'MMM d, yyyy')}`,
                    };
                    addFilter(activeFilter);
                    executeSearch(filterValue);
                  }
                }}
                className="max-w-full rounded-md border"
              />
            </div>
          </div>
        )}
      </>
    );
  };

  const renderLabelsView = () => (
    <>
      <div className="flex items-center border-b px-3">
        <button
          className="text-muted-foreground hover:text-foreground ml-2"
          onClick={() => setCurrentView('filter')}
        >
          <ArrowLeft className="h-4 w-4"/>
        </button>
        <CommandInput
          autoFocus
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search labels..."
          className="border-0"
        />
      </div>
      <ScrollArea className="h-[400px]">
        <div className="p-4">
          {userLabels.length === 0 ? (
            <p className="text-muted-foreground text-center text-sm">
              No labels found. Create labels in Gmail to use them here.
            </p>
          ) : (
            <div className="space-y-2">
              {userLabels
                .filter(
                  (label) =>
                    !searchQuery ||
                    (label.name && label.name.toLowerCase().includes(searchQuery.toLowerCase())),
                )
                .map((label) => (
                  <div
                    key={label.id}
                    className="hover:bg-accent flex cursor-pointer items-center space-x-2 rounded-md border p-2"
                    onClick={() => {
                      if (label.name) {
                        const filterValue = `label:${label.name}`;
                        const activeFilter: ActiveFilter = {
                          id: `filter-${Date.now()}`,
                          type: 'label',
                          value: filterValue,
                          display: `Label: ${label.name}`,
                        };
                        addFilter(activeFilter);
                        executeSearch(filterValue);
                      }
                    }}
                  >
                    {label.color?.backgroundColor && (
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: label.color.backgroundColor }}
                      />
                    )}
                    <span className="text-sm">{label.name || 'Unnamed Label'}</span>
                    {/* {selectedLabels.includes(label.id || '') && (
                      <Check className="ml-auto h-4 w-4" />
                    )} */}
                  </div>
                ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );

  const renderSavedSearchesView = () => (
    <>
      <div className="flex items-center border-b px-3">
        <button
          className="text-muted-foreground hover:text-foreground mr-2"
          onClick={() => setCurrentView('main')}
        >
          ←
        </button>
        <h3 className="font-medium">Saved Searches</h3>
      </div>

      {searchValue.value && (
        <div className="border-b p-3">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Name this search..."
              value={saveSearchName}
              onChange={(e) => setSaveSearchName(e.target.value)}
              className="h-8"
            />
            <Button
              size="sm"
              onClick={() => {
                if (saveSearchName.trim()) {
                  const newSearch: SavedSearch = {
                    id: `saved-${Date.now()}`,
                    name: saveSearchName.trim(),
                    query: searchValue.value,
                    createdAt: new Date(),
                  };
                  saveSavedSearch(newSearch);
                  setSavedSearches(getSavedSearches());
                  setSaveSearchName('');
                }
              }}
              disabled={!saveSearchName.trim()}
            >
              Save Current
            </Button>
          </div>
        </div>
      )}

      <ScrollArea className="h-[400px]">
        <div className="p-4">
          {savedSearches.length === 0 ? (
            <p className="text-muted-foreground text-center text-sm">No saved searches yet</p>
          ) : (
            <div className="space-y-2">
              {savedSearches.map((search) => (
                <div
                  key={search.id}
                  className="hover:bg-accent group flex items-center justify-between rounded-md border p-3"
                >
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => executeSearch(search.query)}
                  >
                    <p className="text-sm font-medium">{search.name}</p>
                    <p className="text-muted-foreground text-xs">{search.query}</p>
                  </div>
                  <button
                    onClick={() => {
                      deleteSavedSearch(search.id);
                      setSavedSearches(getSavedSearches());
                    }}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <Trash2 className="text-destructive h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );

  const renderFilterBuilderView = () => (
    <>
      <div className="flex items-center border-b px-3">
        <button
          className="text-muted-foreground hover:text-foreground mr-2"
          onClick={() => setCurrentView('main')}
        >
          ←
        </button>
        <h3 className="font-medium">Filter Builder</h3>
      </div>

      <ScrollArea className="h-[400px]">
        <div className="space-y-4 p-4">
          <div className="space-y-3">
            {['from', 'to', 'subject'].map((filterType) => {
              const filter = filterOptions.find((f) => f.id === filterType);
              if (!filter) return null;

              return (
                <div key={filterType}>
                  <Label className="text-sm">{filter.name}</Label>
                  <Input
                    placeholder={`Enter ${filter.name.toLowerCase()}...`}
                    value={filterBuilderState[filterType] || ''}
                    onChange={(e) =>
                      setFilterBuilderState({
                        ...filterBuilderState,
                        [filterType]: e.target.value,
                      })
                    }
                    className="h-8"
                  />
                </div>
              );
            })}

            <Separator />

            <div className="space-y-2">
              <Label className="text-sm">Options</Label>
              {['has:attachment', 'is:starred', 'is:unread'].map((filterId) => {
                const filter = filterOptions.find((f) => f.id === filterId);
                if (!filter) return null;

                return (
                  <label key={filterId} className="flex cursor-pointer items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={filterBuilderState[filterId] === 'true'}
                      onChange={(e) =>
                        setFilterBuilderState({
                          ...filterBuilderState,
                          [filterId]: e.target.checked ? 'true' : '',
                        })
                      }
                      className="rounded"
                    />
                    <span className="text-sm">{filter.name}</span>
                  </label>
                );
              })}
            </div>

            <Separator />

            <div>
              <Label className="text-sm">Date Range</Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">After</Label>
                  <Input
                    type="date"
                    value={filterBuilderState.afterDate || ''}
                    onChange={(e) =>
                      setFilterBuilderState({
                        ...filterBuilderState,
                        afterDate: e.target.value,
                      })
                    }
                    className="h-8"
                  />
                </div>
                <div>
                  <Label className="text-xs">Before</Label>
                  <Input
                    type="date"
                    value={filterBuilderState.beforeDate || ''}
                    onChange={(e) =>
                      setFilterBuilderState({
                        ...filterBuilderState,
                        beforeDate: e.target.value,
                      })
                    }
                    className="h-8"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4">
            <Button
              className="w-full"
              onClick={() => {
                const filters: string[] = [];

                ['from', 'to', 'subject'].forEach((filterType) => {
                  const value = filterBuilderState[filterType];
                  if (value) {
                    const filter = filterOptions.find((f) => f.id === filterType);
                    if (filter) {
                      filters.push(filter.action(value));
                    }
                  }
                });

                ['has:attachment', 'is:starred', 'is:unread'].forEach((filterId) => {
                  if (filterBuilderState[filterId] === 'true') {
                    const filter = filterOptions.find((f) => f.id === filterId);
                    if (filter) {
                      filters.push(filter.action());
                    }
                  }
                });

                if (filterBuilderState.afterDate) {
                  const date = format(new Date(filterBuilderState.afterDate), 'yyyy/MM/dd');
                  filters.push(`after:${date}`);
                }
                if (filterBuilderState.beforeDate) {
                  const date = format(new Date(filterBuilderState.beforeDate), 'yyyy/MM/dd');
                  filters.push(`before:${date}`);
                }

                if (filters.length > 0) {
                  const query = filters.join(' ');

                  filters.forEach((filterQuery, index) => {
                    const activeFilter: ActiveFilter = {
                      id: `builder-${Date.now()}-${index}`,
                      type: 'custom',
                      value: filterQuery,
                      display: filterQuery,
                    };
                    addFilter(activeFilter);
                  });

                  executeSearch(query);
                  setFilterBuilderState({});
                }
              }}
              disabled={Object.values(filterBuilderState).every((v) => !v)}
            >
              Apply Filters
            </Button>
          </div>
        </div>
      </ScrollArea>
    </>
  );

  const renderHelpView = () => (
    <>
      <div className="flex items-center border-b px-3">
        <button
          className="text-muted-foreground hover:text-foreground mr-2"
          onClick={() => setCurrentView('main')}
        >
          ←
        </button>
        <h3 className="font-medium">Filter Syntax Help</h3>
      </div>

      <ScrollArea className="h-[400px]">
        <div className="space-y-4 p-4">
          <div>
            <h4 className="mb-2 font-medium">Basic Filters</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">from:email@example.com</code>
                <span className="text-muted-foreground">Emails from specific sender</span>
              </div>
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">to:email@example.com</code>
                <span className="text-muted-foreground">Emails to specific recipient</span>
              </div>
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">subject:"meeting notes"</code>
                <span className="text-muted-foreground">Emails with specific subject</span>
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h4 className="mb-2 font-medium">Status Filters</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">is:unread</code>
                <span className="text-muted-foreground">Unread emails</span>
              </div>
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">is:starred</code>
                <span className="text-muted-foreground">Starred emails</span>
              </div>
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">has:attachment</code>
                <span className="text-muted-foreground">Emails with attachments</span>
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h4 className="mb-2 font-medium">Date Filters</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">after:2024/01/01</code>
                <span className="text-muted-foreground">Emails after date</span>
              </div>
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">before:2024/12/31</code>
                <span className="text-muted-foreground">Emails before date</span>
              </div>
              <div className="flex justify-between">
                <code className="bg-muted rounded px-2 py-1">older_than:1d</code>
                <span className="text-muted-foreground">Emails older than 1 day</span>
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h4 className="mb-2 font-medium">Combining Filters</h4>
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                You can combine multiple filters with spaces. All filters are applied with AND
                logic.
              </p>
              <code className="bg-muted block rounded px-2 py-1">
                from:boss@company.com is:unread has:attachment
              </code>
            </div>
          </div>

          <Separator />

          <div>
            <h4 className="mb-2 font-medium">Natural Language</h4>
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                You can also use natural language queries which will be converted to filters:
              </p>
              <div className="space-y-1">
                <p className="italic">"emails from john about the project"</p>
                <p className="italic">"unread messages with attachments from last week"</p>
                <p className="italic">"starred emails from my boss"</p>
              </div>
            </div>
          </div>

          <Separator />

          <div>
            <h4 className="mb-2 font-medium">Keyboard Shortcuts</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <kbd className="bg-muted rounded px-2 py-1">⌘K</kbd>
                <span className="text-muted-foreground">Open command palette</span>
              </div>
              <div className="flex justify-between">
                <kbd className="bg-muted rounded px-2 py-1">⌘F</kbd>
                <span className="text-muted-foreground">Open filters (when palette is open)</span>
              </div>
              <div className="flex justify-between">
                <kbd className="bg-muted rounded px-2 py-1">⌘S</kbd>
                <span className="text-muted-foreground">Open search (when palette is open)</span>
              </div>
              <div className="flex justify-between">
                <kbd className="bg-muted rounded px-2 py-1">⌘L</kbd>
                <span className="text-muted-foreground">Open labels (when palette is open)</span>
              </div>
              <div className="flex justify-between">
                <kbd className="bg-muted rounded px-2 py-1">ESC</kbd>
                <span className="text-muted-foreground">Go back / Close</span>
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </>
  );

  const renderView = () => {
    switch (currentView) {
      case 'search':
        return renderSearchView();
      case 'filter':
        return renderFilterView();
      case 'dateRange':
        return renderFilterView();
      case 'labels':
        return renderLabelsView();
      case 'savedSearches':
        return renderSavedSearchesView();
      case 'filterBuilder':
        return renderFilterBuilderView();
      case 'help':
        return renderHelpView();
      default:
        return renderMainView();
    }
  };

  return (
    <CommandPaletteContext.Provider
      value={{
        activeFilters,
        clearAllFilters,
      }}
    >
      <CommandDialog
        open={!!open}
        onOpenChange={(isOpen) => {
          if (!isOpen && currentView !== 'main') {
            setCurrentView('main');
            return;
          }
          setOpen(isOpen ? 'true' : null);
        }}
      >
        <VisuallyHidden.VisuallyHidden>
          <DialogTitle>{m['common.commandPalette.title']()}</DialogTitle>
          <DialogDescription>{m['common.commandPalette.description']()}</DialogDescription>
        </VisuallyHidden.VisuallyHidden>
        {renderView()}
      </CommandDialog>
      {children}
    </CommandPaletteContext.Provider>
  );
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <CommandPalette>{children}</CommandPalette>
    </Suspense>
  );
}
