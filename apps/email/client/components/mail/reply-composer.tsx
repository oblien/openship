import { useUndoSend } from '@/hooks/use-undo-send';
import { constructReplyBody, constructForwardBody } from '@/lib/utils';
import { useActiveConnection } from '@/hooks/use-connections';
import { useEmailAliases } from '@/hooks/use-email-aliases';
import { EmailComposer } from '../create/email-composer';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useSettings } from '@/hooks/use-settings';
import { useThread } from '@/hooks/use-threads';
import { useSession } from '@/lib/auth-client';
import { serializeFiles } from '@/lib/schemas';
import { useDraft } from '@/hooks/use-drafts';
import { m } from '@/paraglide/messages';
import type { Sender } from '@/types';
import { useQueryState } from 'nuqs';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import posthog from 'posthog-js';
import { toast } from 'sonner';

interface ReplyComposeProps {
  messageId?: string;
}

export default function ReplyCompose({ messageId }: ReplyComposeProps) {
  const [mode, setMode] = useQueryState('mode');
  const { folder } = useParams<{ folder: string }>();
  const { enableScope, disableScope } = useHotkeysContext();
  const { data: aliases } = useEmailAliases();

  const [draftId, setDraftId] = useQueryState('draftId');
  const [threadId] = useQueryState('threadId');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const { data: emailData, refetch, latestDraft } = useThread(threadId);
  const { data: draft } = useDraft(draftId ?? null);
  const trpc = useTRPC();
  const { mutateAsync: sendEmail } = useMutation(trpc.mail.send.mutationOptions());
  const { data: activeConnection } = useActiveConnection();
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: session } = useSession();
  const { handleUndoSend } = useUndoSend();

  // Find the specific message to reply to
  const replyToMessage =
    (messageId && emailData?.messages.find((msg) => msg.id === messageId)) || emailData?.latest;

  // Initialize recipients and subject when mode changes
  useEffect(() => {
    if (!replyToMessage || !mode || !activeConnection?.email) return;

    const userEmail = activeConnection.email.toLowerCase();
    const senderEmail = replyToMessage.sender.email.toLowerCase();

    // Set subject based on mode

    if (mode === 'reply') {
      // Reply to sender
      const to: string[] = [];

      // If the sender is not the current user, add them to the recipients
      if (senderEmail !== userEmail) {
        to.push(replyToMessage.sender.email);
      } else if (replyToMessage.to && replyToMessage.to.length > 0 && replyToMessage.to[0]?.email) {
        // If we're replying to our own email, reply to the first recipient
        to.push(replyToMessage.to[0].email);
      }

      // Initialize email composer with these recipients
      // Note: The actual initialization happens in the EmailComposer component
    } else if (mode === 'replyAll') {
      const to: string[] = [];
      const cc: string[] = [];

      // Add original sender if not current user
      if (senderEmail !== userEmail) {
        to.push(replyToMessage.sender.email);
      }

      // Add original recipients from To field
      replyToMessage.to?.forEach((recipient) => {
        const recipientEmail = recipient.email.toLowerCase();
        if (recipientEmail !== userEmail && recipientEmail !== senderEmail) {
          to.push(recipient.email);
        }
      });

      // Add CC recipients
      replyToMessage.cc?.forEach((recipient) => {
        const recipientEmail = recipient.email.toLowerCase();
        if (recipientEmail !== userEmail && !to.includes(recipient.email)) {
          cc.push(recipient.email);
        }
      });

      // Initialize email composer with these recipients
    } else if (mode === 'forward') {
      // For forward, we start with empty recipients
      // Just set the subject and include the original message
    }
  }, [mode, replyToMessage, activeConnection?.email]);

  const handleSendEmail = async (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message: string;
    attachments: File[];
    scheduleAt?: string;
  }) => {
    if (!replyToMessage || !activeConnection?.email) return;

    try {
      const userEmail = activeConnection.email.toLowerCase();
      const userName = activeConnection.name || session?.user?.name || '';

      let fromEmail = userEmail;

      if (aliases && aliases.length > 0 && replyToMessage) {
        const allRecipients = [
          ...(replyToMessage.to || []),
          ...(replyToMessage.cc || []),
          ...(replyToMessage.bcc || []),
        ];
        const matchingAlias = aliases.find((alias) =>
          allRecipients.some(
            (recipient) => recipient.email.toLowerCase() === alias.email.toLowerCase(),
          ),
        );

        if (matchingAlias) {
          fromEmail = userName.trim()
            ? `${userName.replace(/[<>]/g, '')} <${matchingAlias.email}>`
            : matchingAlias.email;
        } else {
          const primaryEmail =
            aliases.find((alias) => alias.primary)?.email || aliases[0]?.email || userEmail;
          fromEmail = userName.trim()
            ? `${userName.replace(/[<>]/g, '')} <${primaryEmail}>`
            : primaryEmail;
        }
      }

      const toRecipients: Sender[] = data.to.map((email) => ({
        email,
        name: email.split('@')[0] || 'User',
      }));

      const ccRecipients: Sender[] | undefined = data.cc
        ? data.cc.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const bccRecipients: Sender[] | undefined = data.bcc
        ? data.bcc.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const emailBody =
        mode === 'forward'
          ? constructForwardBody(
              data.message,
              new Date(replyToMessage.receivedOn || '').toLocaleString(),
              { ...replyToMessage.sender, subject: replyToMessage.subject },
              toRecipients,
              //   replyToMessage.decodedBody,
            )
          : constructReplyBody(
              data.message,
              new Date(replyToMessage.receivedOn || '').toLocaleString(),
              replyToMessage.sender,
              toRecipients,
              //   replyToMessage.decodedBody,
            );

      const result = await sendEmail({
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject: data.subject,
        message: emailBody,
        attachments: await serializeFiles(data.attachments),
        fromEmail: fromEmail,
        draftId: draftId ?? undefined,
        headers: {
          'In-Reply-To': replyToMessage?.messageId ?? '',
          References: [
            ...(replyToMessage?.references ? replyToMessage.references.split(' ') : []),
            replyToMessage?.messageId,
          ]
            .filter(Boolean)
            .join(' '),
          'Thread-Id': replyToMessage?.threadId ?? '',
        },
        threadId: replyToMessage?.threadId,
        isForward: mode === 'forward',
        originalMessage: replyToMessage.decodedBody,
        originalMessageId: replyToMessage?.id,
        originalFolder: folder,
        scheduleAt: data.scheduleAt,
      });

      posthog.capture('Reply Email Sent');

      // Reset states
      setMode(null);
      await refetch();

      handleUndoSend(result, settings, {
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        subject: data.subject,
        message: data.message,
        attachments: data.attachments,
        scheduleAt: data.scheduleAt,
      });
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error(m['pages.createEmail.failedToSendEmail']());
    }
  };

  useEffect(() => {
    if (mode) {
      enableScope('compose');
    } else {
      disableScope('compose');
    }
    return () => {
      disableScope('compose');
    };
  }, [mode, enableScope, disableScope]);

  const ensureEmailArray = (
    emails: string | string[] | Array<{ email?: string; name?: string }> | undefined | null,
  ): string[] => {
    if (!emails) return [];
    if (Array.isArray(emails)) {
      return emails
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          return entry?.email ?? '';
        })
        .filter((s) => s.length > 0)
        .map((email) => email.trim().replace(/[<>]/g, ''));
    }
    if (typeof emails === 'string') {
      return emails
        .split(',')
        .map((email) => email.trim())
        .filter((email) => email.length > 0)
        .map((email) => email.replace(/[<>]/g, ''));
    }
    return [];
  };

  if (!mode || !emailData) return null;

  return (
    <div className="w-full rounded-2xl overflow-visible border">
      <EmailComposer
        editorClassName="min-h-[50px]"
        className="w-full max-w-none! pb-1 overflow-visible"
        onSendEmail={handleSendEmail}
        onClose={async () => {
          setMode(null);
          setDraftId(null);
          setActiveReplyId(null);
        }}
        initialMessage={draft?.content ?? latestDraft?.decodedBody}
        initialTo={ensureEmailArray(draft?.to)}
        initialCc={ensureEmailArray(draft?.cc)}
        initialBcc={ensureEmailArray(draft?.bcc)}
        initialSubject={
          draft?.subject ??
          (mode === 'forward' && replyToMessage?.subject
            ? /^fwd:\s/i.test(replyToMessage.subject)
              ? replyToMessage.subject
              : `Fwd: ${replyToMessage.subject}`
            : undefined)
        }
        autofocus={true}
        settingsLoading={settingsLoading}
        replyingTo={replyToMessage?.sender.email}
      />
    </div>
  );
}
