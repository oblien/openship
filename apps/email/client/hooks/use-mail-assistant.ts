import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/providers/query-provider";

export function useMailAssistantAvailability() {
  const trpc = useTRPC();
  return useQuery(trpc.assistant.availability.queryOptions()).data;
}
