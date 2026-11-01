import {
  BookDashedIcon,
  MessageSquareIcon,
  RefreshCcwDotIcon,
  SendIcon,
  RotateCcwIcon,
} from 'lucide-react';
// Upstream shipped these as Workers-AI fallback prompts. We don't run
// Workers AI; the UI only renders these as "default" templates the user
// can override, so an empty string is a safe stand-in.
const SummarizeMessage = '';
const SummarizeThread = '';
const ReSummarizeThread = '';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { AiChatPrompt, StyledEmailAssistantSystemPrompt } from '@/lib/prompts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
// Inlined locally - the upstream server module never made it into the
// fork. These are used as React-Hook-Form field keys.
enum EPrompts {
  Chat = 'chat',
  Compose = 'compose',
  SummarizeThread = 'summarizeThread',
  ReSummarizeThread = 'reSummarizeThread',
  SummarizeMessage = 'summarizeMessage',
}
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useForm } from 'react-hook-form';
import { Paper } from '../icons/icons';
import { Textarea } from './textarea';
import { useMemo } from 'react';
import { toast } from 'sonner';

const isPromptValid = (prompt: string): boolean => {
  const trimmed = prompt.trim();
  return trimmed !== '' && trimmed.toLowerCase() !== 'undefined';
};

const initialValues: Record<EPrompts, string> = {
  [EPrompts.Chat]: '',
  [EPrompts.Compose]: '',
  [EPrompts.SummarizeThread]: '',
  [EPrompts.ReSummarizeThread]: '',
  [EPrompts.SummarizeMessage]: '',
};

const fallbackPrompts = {
  [EPrompts.Chat]: AiChatPrompt(),
  [EPrompts.Compose]: StyledEmailAssistantSystemPrompt(),
  [EPrompts.SummarizeThread]: SummarizeThread,
  [EPrompts.ReSummarizeThread]: ReSummarizeThread,
  [EPrompts.SummarizeMessage]: SummarizeMessage,
};

export function PromptsDialog() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: prompts } = useQuery(trpc.brain.getPrompts.queryOptions());

  const { mutateAsync: updatePrompt, isPending: isSavingPrompt } = useMutation(
    trpc.brain.updatePrompt.mutationOptions({
      onSuccess: () => {
        toast.success('Prompt updated');
        queryClient.invalidateQueries({ queryKey: trpc.brain.getPrompts.queryKey() });
      },
      onError: (error) => {
        toast.error(error.message ?? 'Failed to update prompt');
      },
    }),
  );

  const mappedValues = useMemo(() => {
    if (!prompts) return initialValues;
    return Object.fromEntries(
      Object.entries(initialValues).map(([key]) => [
        key,
        isPromptValid(prompts[key as EPrompts] ?? '')
          ? prompts[key as EPrompts]
          : fallbackPrompts[key as EPrompts],
      ]),
    ) as Record<EPrompts, string>;
  }, [prompts]);

  const { register, getValues, setValue } = useForm<Record<EPrompts, string>>({
    defaultValues: initialValues,
    values: mappedValues,
  });

  const resetToDefault = (promptType: EPrompts) => {
    setValue(promptType, fallbackPrompts[promptType]);
  };

  const renderPromptButtons = (promptType: EPrompts, enumType: EPrompts) => (
    <div className="flex gap-2">
      <Button
        size="sm"
        onClick={() =>
          updatePrompt({
            promptType: enumType,
            content: getValues(promptType),
          })
        }
        disabled={isSavingPrompt}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => resetToDefault(promptType)}
        disabled={isSavingPrompt}
      >
        <RotateCcwIcon className="mr-1 h-3 w-3" />
        Reset to Default
      </Button>
    </div>
  );

  return (
    <TooltipProvider delayDuration={0}>
      <Dialog>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button variant="ghost" aria-label="Prompts" className="md:h-fit md:px-2">
                <Paper className="dark:fill-iconDark fill-iconLight h-3.5 w-3.5" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Prompts</TooltipContent>
        </Tooltip>
        <DialogContent className="max-w-(--breakpoint-lg)" showOverlay={true}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              AI System Prompts
            </DialogTitle>
            <DialogDescription>
              Customize the system prompts used by the assistant.
            </DialogDescription>
          </DialogHeader>
          <Tabs className="mt-2">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="chat">
                <MessageSquareIcon className="mr-2 h-4 w-4" /> Chat
              </TabsTrigger>
              <TabsTrigger value="compose">
                <SendIcon className="mr-2 h-4 w-4" /> Compose
              </TabsTrigger>
              <TabsTrigger value="summarizeThread">
                <BookDashedIcon className="mr-2 h-4 w-4" /> Summarize Thread
              </TabsTrigger>
              <TabsTrigger value="reSummarizeThread">
                <RefreshCcwDotIcon className="mr-2 h-4 w-4" /> Re-Summarize Thread
              </TabsTrigger>
              <TabsTrigger value="summarizeMessage">
                <BookDashedIcon className="mr-2 h-4 w-4" /> Summarize Message
              </TabsTrigger>
            </TabsList>
            {prompts ? (
              <TabsContent value="chat" className="space-y-2">
                <span className="text-muted-foreground mb-2 flex gap-2 text-sm">
                  This system prompt is used in the chat sidebar agent. The agent has multiple tools
                  available.
                </span>
                <Textarea className="min-h-60" {...register(EPrompts.Chat)} />
                {renderPromptButtons(EPrompts.Chat, EPrompts.Chat)}
              </TabsContent>
            ) : null}
            {prompts ? (
              <TabsContent value="compose" className="space-y-2">
                <span className="text-muted-foreground mb-2 flex gap-2 text-sm">
                  This system prompt is used to compose emails that sound like you.
                </span>
                <Textarea className="min-h-60" {...register(EPrompts.Compose)} />
                {renderPromptButtons(EPrompts.Compose, EPrompts.Compose)}
              </TabsContent>
            ) : null}
            {prompts ? (
              <TabsContent value="summarizeThread" className="space-y-2">
                <span className="text-muted-foreground mb-2 flex gap-2 text-sm">
                  This system prompt is used to summarize threads. It takes the entire thread and
                  key information and summarizes them.
                </span>
                <Textarea className="min-h-60" {...register(EPrompts.SummarizeThread)} />
                {renderPromptButtons(EPrompts.SummarizeThread, EPrompts.SummarizeThread)}
              </TabsContent>
            ) : null}
            {prompts ? (
              <TabsContent value="reSummarizeThread" className="space-y-2">
                <span className="text-muted-foreground mb-2 flex gap-2 text-sm">
                  This system prompt is used to re-summarize threads. It's used when the thread
                  messages change and a new context is needed.
                </span>
                <Textarea className="min-h-60" {...register(EPrompts.ReSummarizeThread)} />
                {renderPromptButtons(EPrompts.ReSummarizeThread, EPrompts.ReSummarizeThread)}
              </TabsContent>
            ) : null}
            {prompts ? (
              <TabsContent value="summarizeMessage" className="space-y-2">
                <span className="text-muted-foreground mb-2 flex gap-2 text-sm">
                  This system prompt is used to summarize messages. It takes a single message and
                  summarizes it.
                </span>
                <Textarea className="min-h-60" {...register(EPrompts.SummarizeMessage)} />
                {renderPromptButtons(EPrompts.SummarizeMessage, EPrompts.SummarizeMessage)}
              </TabsContent>
            ) : null}
          </Tabs>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
