import { cn } from "@/lib/utils";
import { MailIcon } from "./mail-icons";

export function AiProviderIcon({
  provider,
  className,
}: {
  provider: "openai" | "anthropic" | "custom";
  className?: string;
}) {
  if (provider === "custom") return <MailIcon name="code" className={className} />;
  return (
    <img
      src={provider === "openai" ? "/openai.png" : "/claude.png"}
      alt=""
      width={20}
      height={20}
      className={cn(
        "size-5 shrink-0 object-contain",
        provider === "openai" && "dark:invert",
        className,
      )}
    />
  );
}
