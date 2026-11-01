"use client";

import dynamic from "next/dynamic";
import { ScaleLoading } from "./ScaleLoading";

const ScaleEditor = dynamic(() => import("./ScaleEditor"), { ssr: false, loading: ScaleLoading });

export function ScalePage({ storageKey }: { storageKey: string }) {
  return <ScaleEditor key={storageKey} storageKey={storageKey} />;
}
