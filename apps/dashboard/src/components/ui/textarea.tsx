import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { inputVariants } from "./input";

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>, VariantProps<typeof inputVariants> {}

export const Textarea = ({ className = "", variant, ...props }: TextareaProps) => (
  <textarea
    className={variant === "filled"
      ? cn(inputVariants({ variant }), "h-auto min-h-11 resize-y", className)
      : `w-full px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none ${className}`}
    {...props}
  />
);
