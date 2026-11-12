import { Suspense, type ReactNode } from "react";
import { LibraryContent } from "./LibraryContent";

export default function LibraryLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense>
        <LibraryContent />
      </Suspense>
      {children}
    </>
  );
}
