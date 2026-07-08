"use client";
import * as React from "react";
import { cn } from "../lib/cn";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "ghost" | "outline";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "default" && "bg-white text-black hover:bg-white/90",
        variant === "ghost" && "hover:bg-white/10 text-white",
        variant === "outline" && "border border-white/15 hover:bg-white/10 text-white",
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
