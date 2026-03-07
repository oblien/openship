"use client";

import React, { useRef, useEffect, useState } from "react";

export type ToggleOption<T = string> = {
  value: T;
  label?: string;
  icon?: React.ReactNode;
};

export interface SlidingToggleProps<T = string> {
  options: ToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  variant?: "rounded" | "square";
  selectedBg?: string;
  selectedTextColor?: string;
  unselectedTextColor?: string;
  backgroundColor?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function SlidingToggle<T extends string = string>({
  options,
  value,
  onChange,
  variant = "rounded",
  selectedBg = "bg-primary",
  selectedTextColor = "text-primary-foreground",
  unselectedTextColor = "text-muted-foreground",
  backgroundColor = "bg-card",
  size = "md",
  className = "",
}: SlidingToggleProps<T>) {
  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [pillStyle, setPillStyle] = useState({ width: 0, left: 0 });

  // Size configurations
  const sizeConfig = {
    sm: {
      buttonSize: "w-8 h-8",
      iconSize: "w-3.5 h-3.5",
      textSize: "text-xs",
      gap: "gap-1.5",
    },
    md: {
      buttonSize: "w-10 h-10",
      iconSize: "w-4 h-4",
      textSize: "text-sm",
      gap: "gap-2",
    },
    lg: {
      buttonSize: "w-12 h-12",
      iconSize: "w-5 h-5",
      textSize: "text-base",
      gap: "gap-2",
    },
  };

  const config = sizeConfig[size];

  // Border radius based on variant
  const borderRadius = variant === "rounded" ? "rounded-full" : "rounded-xl";
  const pillRadius = variant === "rounded" ? "rounded-full" : "rounded-lg";

  // Update pill position when selection changes
  useEffect(() => {
    const selectedButton = buttonsRef.current[selectedIndex];
    if (selectedButton) {
      setPillStyle({
        width: selectedButton.offsetWidth,
        left: selectedButton.offsetLeft,
      });
    }
  }, [selectedIndex, options]);

  return (
    <div
      className={`relative inline-flex items-center ${backgroundColor} ${borderRadius} p-1 gap-1.5 ${className}`}
    >
      {/* Sliding Background Pill */}
      <div
        className={`absolute ${selectedBg} ${pillRadius} -ml-1 transition-all duration-300 ease-out shadow-sm`}
        style={{
          width: `${pillStyle.width}px`,
          height: 'calc(100% - 0.5rem)',
          transform: `translateX(${pillStyle.left}px)`,
          top: '0.25rem',
        }}
      />

      {/* Option Buttons */}
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const hasLabel = !!option.label;
        const hasIcon = !!option.icon;

        return (
          <button
            key={option.value}
            ref={(el) => { buttonsRef.current[index] = el; }}
            onClick={() => onChange(option.value)}
            className={`relative z-10 ${
              hasLabel ? 'px-4 py-2' : config.buttonSize
            } transition-all duration-300 ${pillRadius} ${
              isSelected ? selectedTextColor : unselectedTextColor
            } hover:opacity-80 font-medium ${config.textSize} flex items-center justify-center flex-shrink-0`}
          >
            <div
              className={`flex items-center justify-center ${
                hasLabel && hasIcon ? config.gap : ""
              }`}
            >
              {hasIcon && (
                <span className={config.iconSize}>
                  {option.icon}
                </span>
              )}
              {hasLabel && <span className="whitespace-nowrap">{option.label}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
