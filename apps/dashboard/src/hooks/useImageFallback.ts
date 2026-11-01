"use client";

import { useCallback, useState } from "react";

/** Handle images that failed before hydration, and allow a changed URL to load. */
export function useImageFallback(src: string | null | undefined) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const onError = useCallback(() => {
    if (src) setFailedSource(src);
  }, [src]);
  const ref = useCallback((image: HTMLImageElement | null) => {
    // A cached error can precede React's listener. The element's loaded state
    // is authoritative; no timer or extra image request is needed.
    if (image?.complete && image.naturalWidth === 0) onError();
  }, [onError]);
  return { showImage: !!src && failedSource !== src, ref, onError };
}
