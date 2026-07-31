import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useSearchValue } from '@/hooks/use-search-value';
import type { Label } from '@/types';
import { cn } from '@/lib/utils';
import * as React from 'react';

export const RenderLabels = ({ count = 1, labels }: { count?: number; labels: Label[] }) => {
  const [searchValue, setSearchValue] = useSearchValue();
  const handleFilterByLabel = (label: Label) => (event: any) => {
    event.stopPropagation();
    const existingValue = searchValue.value;
    if (existingValue.includes(`label:${label.name}`)) {
      setSearchValue({
        value: existingValue.replace(`label:${label.name}`, ''),
        highlight: '',
        folder: '',
      });
      return;
    }
    const newValue = existingValue ? `${existingValue} label:${label.name}` : `label:${label.name}`;
    setSearchValue({
      value: newValue,
      highlight: '',
      folder: '',
    });
  };

  if (!labels.length) return null;

  const visibleLabels = labels.slice(0, count);
  const hiddenLabels = labels.slice(count);

  return (
    <div className="flex gap-1">
      {visibleLabels.map((label) => (
        <button
          key={label.id}
          onClick={handleFilterByLabel(label)}
          className={cn(
            'inline-block overflow-hidden truncate rounded bg-[#E8DEFD] px-1.5 py-0.5 text-xs font-medium text-[#2C2241] dark:bg-[#2C2241] dark:text-[#E8DEFD]',
            searchValue.value.includes(`label:${label.name}`) && 'border-white',
          )}
          style={{
            background: label.color?.backgroundColor,
            color: label.color?.textColor,
          }}
        >
          {label.name}
        </button>
      ))}
      {hiddenLabels.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-foreground dark:bg-subtleBlack bg-subtleWhite inline-block overflow-hidden truncate rounded px-1.5 py-0.5 text-xs font-medium cursor-pointer">
              +{hiddenLabels.length}
            </button>
          </TooltipTrigger>
          <TooltipContent className="z-99 flex gap-1 px-1 py-1" side="top" align="end">
            {hiddenLabels.map((label) => (
              <button
                key={label.id}
                onClick={handleFilterByLabel(label)}
                className={cn(
                  'inline-block overflow-hidden truncate rounded bg-[#E8DEFD] px-1.5 py-0.5 text-xs font-medium text-[#2C2241] dark:bg-[#2C2241] dark:text-[#E8DEFD]',
                  searchValue.value.includes(`label:${label.name}`) && 'border-white',
                )}
                style={{
                  backgroundColor: label.color?.backgroundColor,
                  color: label.color?.textColor,
                }}
              >
                {label.name}
              </button>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
