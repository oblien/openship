import type { ReactNode } from "react";
import { Navbar, Footer } from "@/components/landing";
import "./blog.css";

export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <div className="res-page">
      <Navbar />
      {children}
      <Footer />
    </div>
  );
}
