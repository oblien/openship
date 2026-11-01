import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Shared appearance for text inputs and form-style select triggers. */
export const inputVariants = cva(
  "flex h-11 w-full rounded-xl px-3.5 py-2 text-sm text-[color:var(--th-input-text)] transition-all duration-150 placeholder:text-[color:var(--th-input-placeholder)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--th-input-bd-focus)]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border border-input bg-[var(--th-input-bg)] focus:bg-[var(--th-input-bg-focus)] focus-visible:border-[var(--th-input-bd-focus)]",
        filled: "border-0 bg-[var(--th-input-bg)] focus:bg-[var(--th-input-bg-focus)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>, VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, ...props }, ref) => (
    <input type={type} className={cn(inputVariants({ variant }), className)} ref={ref} {...props} />
  ),
);
Input.displayName = "Input";

export { Input };
