import type { ReactNode } from "react";
import { Navbar, Footer } from "@/components/landing";
import "./apps.css";

export default function AppsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Navbar />
      {children}
      <Footer />
    </>
  );
}
