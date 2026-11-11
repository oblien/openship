import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BlockedSenders } from '@/components/settings/blocked-senders';
import { SettingsCard } from '@/components/settings/settings-card';
import { userSettingsSchema } from '@zero/server/schemas';
import { ScrollArea } from '@/components/ui/scroll-area';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
// import { saveUserSettings } from '@/actions/settings';
import { useSettings } from '@/hooks/use-settings';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { m } from '@/paraglide/messages';
import { XIcon } from 'lucide-react';
import { toast } from 'sonner';
import * as z from 'zod';

export default function PrivacyPage() {
  const [isSaving, setIsSaving] = useState(false);
  const { data, refetch } = useSettings();
  const trpc = useTRPC();
  const { mutateAsync: saveUserSettings } = useMutation(trpc.settings.save.mutationOptions());

  const form = useForm<z.infer<typeof userSettingsSchema>>({
    resolver: zodResolver(userSettingsSchema),
  });

  const externalImages = data?.settings.externalImages;
  useEffect(() => {
    if (data) {
      form.reset({
        ...data.settings,
        trustedSenders: data.settings.trustedSenders,
        externalImages: !!data.settings.externalImages,
      });
    }
  }, [form, data]);

  async function onSubmit(values: z.infer<typeof userSettingsSchema>) {
    if (data) {
      setIsSaving(true);
      toast.promise(
        saveUserSettings({
          ...data.settings,
          ...values,
        }),
        {
          success: m['common.settings.saved'](),
          error: m['common.settings.failedToSave'](),
          finally: async () => {
            await refetch();
            setIsSaving(false);
          },
        },
      );
    }
  }

  return (
    <div className="grid gap-6">
      <BlockedSenders />
      <SettingsCard
        title={m['pages.settings.privacy.title']()}
        description={m['pages.settings.privacy.description']()}
        footer={
          <Button type="submit" form="privacy-form" disabled={isSaving}>
            {isSaving ? m['common.actions.saving']() : m['common.actions.saveChanges']()}
          </Button>
        }
      >
        <Form {...form}>
          <form id="privacy-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
            <div className="flex w-full flex-col items-start gap-5">
              <FormField
                control={form.control}
                name="externalImages"
                render={({ field }) => (
                  <FormItem className="bg-popover flex w-full flex-row items-center justify-between rounded-lg border p-4 md:w-auto">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        {m['pages.settings.privacy.externalImages']()}
                      </FormLabel>
                      <FormDescription>
                        {m['pages.settings.privacy.externalImagesDescription']()}
                      </FormDescription>
                    </div>
                    <FormControl className="ml-4">
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="trustedSenders"
                render={({ field }) =>
                  (field.value?.length || 0) > 0 && !externalImages ? (
                    <FormItem className="bg-popover flex w-full flex-col rounded-lg border p-4">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">
                          {m['pages.settings.privacy.trustedSenders']()}
                        </FormLabel>
                        <FormDescription>
                          {m['pages.settings.privacy.trustedSendersDescription']()}
                        </FormDescription>
                      </div>
                      <ScrollArea className="flex max-h-32 flex-col pr-3">
                        {field.value?.map((senderEmail) => (
                          <div
                            className="mt-1.5 flex items-center justify-between first:mt-0"
                            key={senderEmail}
                          >
                            <span>{senderEmail}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() =>
                                    field.onChange(field.value?.filter((e) => e !== senderEmail))
                                  }
                                >
                                  <XIcon className="h-4 w-4 transition hover:opacity-80" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>{m['common.actions.remove']()}</TooltipContent>
                            </Tooltip>
                          </div>
                        ))}
                      </ScrollArea>
                    </FormItem>
                  ) : (
                    <></>
                  )
                }
              />
            </div>
          </form>
        </Form>
      </SettingsCard>
    </div>
  );
}
