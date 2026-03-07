"use client";

import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

interface Option<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface CustomSelectProps<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  className?: string;
}

export function CustomSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select",
  className = "",
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const handleSelect = (optionValue: T) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Select Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          w-full px-4 py-3 rounded-2xl text-sm font-medium
          transition-all duration-200 flex items-center justify-between gap-2
          border border-black/[0.04]
          ${isOpen 
            ? 'bg-white border-black/10' 
            : 'bg-white/60 hover:bg-white hover:border-black/[0.08]'
          }
        `}
        type="button"
      >
        <span className="flex items-center gap-2 truncate text-black/70">
          {selectedOption?.icon}
          {selectedOption?.label || <span className="text-black/40">{placeholder}</span>}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-black/40 transition-transform duration-200 flex-shrink-0 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-2 bg-white border border-black/[0.06] rounded-2xl overflow-hidden shadow-xl shadow-black/[0.08]">
          <div className="py-1.5 max-h-64 overflow-y-auto">
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  onClick={() => handleSelect(option.value)}
                  className={`
                    w-full px-4 py-2.5 text-left flex items-center justify-between gap-2 
                    text-sm transition-all duration-150
                    ${isSelected 
                      ? 'bg-black/[0.03] text-black font-medium' 
                      : 'text-black/60 hover:text-black hover:bg-black/[0.02]'
                    }
                  `}
                  type="button"
                >
                  <span className="flex items-center gap-2 truncate">
                    {option.icon}
                    {option.label}
                  </span>
                  {isSelected && (
                    <Check className="w-3.5 h-3.5 text-black/40 flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
