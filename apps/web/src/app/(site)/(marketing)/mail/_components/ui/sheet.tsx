"use client";
import * as React from "react";
import { cn } from "../lib/cn";

type Ctx = { open: boolean; setOpen: (v: boolean) => void };
const SheetContext = React.createContext<Ctx | null>(null);

export function Sheet({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <SheetContext.Provider value={{ open, setOpen }}>{children}</SheetContext.Provider>
  );
}

export function SheetTrigger({
  asChild,
  children,
}: {
  asChild?: boolean;
  children: React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
}) {
  const ctx = React.useContext(SheetContext)!;
  const childOnClick = children.props.onClick;
  return React.cloneElement(children, {
    onClick: (e: React.MouseEvent) => {
      ctx.setOpen(true);
      childOnClick?.(e);
    },
  });
}

export function SheetContent({
  className,
  children,
  side = "right",
}: {
  className?: string;
  children: React.ReactNode;
  side?: "left" | "right" | "top" | "bottom";
}) {
  const ctx = React.useContext(SheetContext)!;
  if (!ctx.open) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={() => ctx.setOpen(false)}
      />
      <div
        className={cn(
          "fixed z-50 bg-[#0F0F0F] p-6 border border-white/10",
          side === "right" && "right-0 top-0 h-full w-3/4 max-w-sm",
          side === "left" && "left-0 top-0 h-full w-3/4 max-w-sm",
          side === "top" && "top-0 inset-x-0",
          side === "bottom" && "bottom-0 inset-x-0",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}

export function SheetHeader({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("mb-4", className)}>{children}</div>;
}

export function SheetTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <h2 className={cn("text-lg font-semibold text-white", className)}>{children}</h2>;
}
