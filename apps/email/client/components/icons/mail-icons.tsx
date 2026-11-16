import { cn } from "@/lib/utils";
import type sources from "./mail-icons.sources.json";

// Original PNGs from the shared png-icons collection, tinted with the current theme.
export function MailIcon({ name, className }: { name: keyof typeof sources; className?: string }) {
  const mask = `url('/icons/mail/${name}.png') center / contain no-repeat`;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={{ mask, WebkitMask: mask }}
    />
  );
}

export function AssistantIcon({ className }: { className?: string }) {
  return (
    <MailIcon
      name="assistant"
      className={cn("size-5 text-iconLight dark:text-iconDark", className)}
    />
  );
}

export function ScheduledIcon({ className }: { className?: string }) {
  return (
    <MailIcon
      name="scheduled"
      className={cn("size-5 text-iconLight dark:text-iconDark", className)}
    />
  );
}
