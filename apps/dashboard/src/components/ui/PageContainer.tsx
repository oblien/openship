import { cn } from "@/lib/utils";

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
  outerClassName?: string;
  fullScreen?: boolean;
}

export function PageContainer({
  children,
  className,
  outerClassName,
  fullScreen = true,
}: PageContainerProps) {
  const inner = (
    <div className={cn("max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6", className)}>
      {children}
    </div>
  );

  if (!fullScreen) return inner;

  return (
    <div className={cn("min-h-screen bg-background", outerClassName)}>
      {inner}
    </div>
  );
}
