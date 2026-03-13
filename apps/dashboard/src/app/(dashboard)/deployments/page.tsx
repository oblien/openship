"use client";

import React from "react";
import { DeploymentsContent } from "./components";

export default function DeploymentsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <DeploymentsContent />
      </div>
    </div>
  );
}
