/**
 * Openship logo — a stylised "O" built with a bordered div.
 * Uses CSS border-foreground so it renders instantly (no JS theme check).
 */
export function Logo({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <div
      className={`shrink-0 rounded-full border-[3px] border-foreground ${className ?? ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
