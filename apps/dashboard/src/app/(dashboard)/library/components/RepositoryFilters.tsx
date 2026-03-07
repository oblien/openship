import React from "react";
import { generateIcon } from "@/utils/icons";
import { SlidingToggle } from "@/components/ui/SlidingToggle";
import { List, Grid3x3 } from "lucide-react";

type VisibilityFilter = "all" | "public" | "private";
type SortBy = "name" | "updated" | "stars";
type ViewMode = "list" | "grid";

interface RepositoryFiltersProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  visibilityFilter: VisibilityFilter;
  onVisibilityChange: (value: VisibilityFilter) => void;
  sortBy: SortBy;
  onSortChange: (value: SortBy) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
}

const visibilityOptions = [
  { value: "all" as const, label: "All repositories" },
  { value: "public" as const, label: "Public", icon: "world-229-1658433759.png" },
  { value: "private" as const, label: "Private", icon: "lock-65-1691989638.png" },
];
const RepositoryFilters: React.FC<RepositoryFiltersProps> = ({
  searchTerm,
  onSearchChange,
  visibilityFilter,
  onVisibilityChange,
  sortBy,
  onSortChange,
  viewMode = "list",
  onViewModeChange,
}) => {
  return (
    <div className="mb-6">
      {/* Search Bar in Card */}
      <div className="bg-white rounded-[20px] sm:rounded-full p-4 sm:p-5 sm:py-2 mb-4 flex flex-col sm:flex-row justify-between gap-4 sm:gap-0" >

        {/* Filter Pills */}
        <div className="flex items-center gap-2 flex-wrap w-full">
          {/* Visibility Pills */}
          {visibilityOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => onVisibilityChange(option.value)}
              className={`px-3 sm:px-4 py-2 rounded-full text-xs sm:text-sm font-normal transition-all border ${option.icon ? 'flex items-center gap-1.5' : ''
                } ${visibilityFilter === option.value
                  ? "bg-indigo-50 text-indigo-700 border-indigo-50"
                  : "bg-white border-black/10 text-black/70 hover:bg-black/5"
                }`}
            >
              {option.icon && generateIcon(option.icon, 18, 'currentColor')}
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 sm:gap-4 w-full">
          <div className="relative flex-1">
            <div className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 pointer-events-none">
              {generateIcon('search-1-51-1662495333.png', 20, 'rgba(0,0,0,0.35)')}
            </div>
            <input
              type="text"
              placeholder="Search repositories..."
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full pl-11 sm:pl-14 pr-4 sm:pr-6 py-2 bg-black/5 border border-transparent rounded-full text-sm sm:text-base text-black outline-none transition-all placeholder:text-black/40"
            />
          </div>

          {/* Hide view toggle on mobile */}
          <div className="hidden sm:block">
            <SlidingToggle
              options={[
                { value: 'list', icon: <List className="w-5 h-5" />, },
                { value: 'grid', icon: <Grid3x3 className="w-5 h-5" />, },
              ]}
              value={viewMode}
              onChange={(value: ViewMode) => onViewModeChange?.(value)}
              variant="rounded"
              selectedBg="bg-black"
              selectedTextColor="text-white"
              unselectedTextColor="text-black/60"
              backgroundColor="bg-white"
              size="lg"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default RepositoryFilters;
