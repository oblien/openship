"use client";

import { useImageFallback } from "@/hooks/useImageFallback";
import { cn } from "@/lib/utils";

export function UserAvatar({
  image,
  name,
  className,
}: {
  image?: string | null;
  name: string;
  className?: string;
}) {
  const fallback = useImageFallback(image);
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground/[0.08] text-sm font-semibold uppercase text-foreground",
        className,
      )}
    >
      {fallback.showImage ? (
        <img
          ref={fallback.ref}
          src={image!}
          alt=""
          referrerPolicy="no-referrer"
          onError={fallback.onError}
          className="size-full object-cover"
        />
      ) : (
        name[0] || "?"
      )}
    </span>
  );
}
