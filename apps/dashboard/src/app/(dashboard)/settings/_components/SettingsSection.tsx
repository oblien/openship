"use client";

export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
  iconBg = "bg-primary/10",
  iconColor = "text-primary",
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
  iconBg?: string;
  iconColor?: string;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className={`w-9 h-9 ${iconBg} rounded-xl flex items-center justify-center`}>
          <Icon className={`size-[18px] ${iconColor}`} />
        </div>
        <div>
          <h2 className="font-semibold text-foreground text-[15px]">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
