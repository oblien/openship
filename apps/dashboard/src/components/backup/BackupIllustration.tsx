import { Icon } from "@repo/ui/icons";

export function BackupIllustration() {
  return (
    <svg
      viewBox="0 0 224 128"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none mb-4 h-auto w-48 max-w-full shrink-0 select-none text-muted-foreground"
    >
      <ellipse cx="112" cy="78" rx="84" ry="38" fill="var(--th-sf-03)" />

      {/* Saved snapshots, using the same layered cards as the project illustration. */}
      <rect x="64" y="18" width="104" height="76" rx="12" fill="var(--th-sf-03)" stroke="var(--th-on-08)" />
      <rect x="54" y="27" width="104" height="76" rx="12" fill="var(--th-card-bg)" stroke="var(--th-on-12)" />
      <rect x="44" y="36" width="104" height="76" rx="12" fill="var(--th-card-bg-solid)" stroke="var(--th-on-20)" />
      <path d="M45 56h102" stroke="var(--th-on-08)" />
      <g fill="var(--th-on-25)">
        <circle cx="57" cy="46" r="2" />
        <circle cx="65" cy="46" r="2" />
        <circle cx="73" cy="46" r="2" />
      </g>
      <Icon name="hard-drive" x="56" y="72" size="24" />
      <rect x="90" y="75" width="40" height="4" rx="2" fill="var(--th-on-16)" />
      <rect x="90" y="85" width="30" height="4" rx="2" fill="var(--th-on-08)" />
      <rect x="90" y="95" width="20" height="3" rx="1.5" fill="var(--th-on-08)" />

      <path d="M170 40h5a12 12 0 0 1 12 12v10" stroke="var(--th-on-20)" strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" />
      <circle cx="172" cy="87" r="22" fill="var(--th-card-bg-solid)" stroke="var(--th-on-16)" />
      <Icon name="database-backup" x="158" y="73" size="28" />

      <circle cx="27" cy="64" r="3" fill="var(--th-on-10)" />
      <path d="M201 104v6m-3-3h6" stroke="var(--th-on-20)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
