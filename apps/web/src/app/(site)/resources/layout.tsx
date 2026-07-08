import type { ReactNode } from "react";
import { Navbar, Footer } from "@/components/landing";
import "./resources.css";

export default function ResourcesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="res-page">
      <Navbar />
      {children}
      <Footer />
    </div>
  );
}
