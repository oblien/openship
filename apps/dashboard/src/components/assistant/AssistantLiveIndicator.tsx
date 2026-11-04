import styles from "./assistant-live.module.css";

export function AssistantLiveIndicator({ label }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 text-xs text-muted-foreground"
      role={label ? "status" : undefined}
    >
      {label && <span>{label}</span>}
      <span className={styles.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}
