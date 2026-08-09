import { cleanEmailAddresses } from '../lib/email-utils';
import { trpcClient } from '@/providers/query-provider';
import type { Route } from './+types/mailto-handler';
import { authProxy } from '@/lib/auth-proxy';

// Function to parse mailto URLs
async function parseMailtoUrl(mailtoUrl: string) {
  if (!mailtoUrl.startsWith('mailto:')) {
    return null;
  }

  try {
    // Remove mailto: prefix to get the raw email and query part
    const mailtoContent = mailtoUrl.substring(7); // "mailto:".length === 7

    // Split at the first ? to separate email from query params
    const [emailPart, queryPart] = mailtoContent.split('?', 2);

    // Decode the email address - might be double-encoded
    const toEmail = decodeURIComponent(emailPart || '');

    // Default values
    let subject = '';
    let body = '';
    let cc = '';
    let bcc = '';

    // Parse query parameters if they exist
    if (queryPart) {
      try {
        // Try to decode the query part - it might be double-encoded
        // (once by the browser and once by our encodeURIComponent)
        let decodedQueryPart = queryPart;

        // Try decoding up to twice to handle double-encoding
        try {
          decodedQueryPart = decodeURIComponent(decodedQueryPart);
          // Try one more time in case of double encoding
          try {
            decodedQueryPart = decodeURIComponent(decodedQueryPart);
          } catch {
            // If second decoding fails, use the result of the first decoding
          }
        } catch {
          // If first decoding fails, try parsing directly
          decodedQueryPart = queryPart;
        }

        const queryParams = new URLSearchParams(decodedQueryPart);

        // Get and decode parameters
        const rawSubject = queryParams.get('subject') || '';
        const rawBody = queryParams.get('body') || '';
        const rawCc = queryParams.get('cc') || '';
        const rawBcc = queryParams.get('bcc') || '';

        // Try to decode them in case they're still encoded
        try {
          subject = decodeURIComponent(rawSubject);
        } catch {
          subject = rawSubject;
        }

        try {
          body = decodeURIComponent(rawBody);
        } catch {
          body = rawBody;
        }

        try {
          cc = decodeURIComponent(rawCc);
        } catch {
          cc = rawCc;
        }

        try {
          bcc = decodeURIComponent(rawBcc);
        } catch {
          bcc = rawBcc;
        }
      } catch (e) {
        console.error('Error parsing query parameters:', e);
      }
    }

    // Return the parsed data if email is valid - handle multiple recipients
    if (toEmail) {
      console.log('Parsed mailto data:', { to: toEmail, subject, body, cc, bcc });
      return { to: toEmail, subject, body, cc, bcc };
    }
  } catch (error) {
    console.error('Failed to parse mailto URL:', error);
  }

  return null;
}

// Function to create a draft and get its ID
async function createDraftFromMailto(mailtoData: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000; // 1 second

  // Helper function to handle Invalid To header errors by toggling format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleInvalidToHeader = (draftData: any) => {
    if (Array.isArray(draftData.to)) {
      // Convert array to comma-separated string
      draftData.to = draftData.to.join(',');
    } else if (typeof draftData.to === 'string') {
      // Convert string to array
      draftData.to = draftData.to.split(',').map((e: string) => e.trim().replace(/^<|>$/g, ''));
    }
  };

  try {
    // Ensure any non-standard line breaks are normalized to \n
    const normalizedBody = mailtoData.body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Create proper HTML-encoded content by wrapping all paragraphs in <p> tags
    // This is the format that will work best with the editor
    const htmlContent = `<!DOCTYPE html><html><body>
      ${normalizedBody
        .split(/\n\s*\n/)
        .map((paragraph) => {
          return `<p>${paragraph.replace(/\n/g, '<br />').replace(/\s{2,}/g, (match) => '&nbsp;'.repeat(match.length))}</p>`;
        })
        .join('\n')}
    </body></html>`;

    // For the draft creation, we need to ensure we're providing the to/cc/bcc in the proper format
    const toAddresses = cleanEmailAddresses(mailtoData.to);
    const ccAddresses = mailtoData.cc ? cleanEmailAddresses(mailtoData.cc) : [];
    const bccAddresses = mailtoData.bcc ? cleanEmailAddresses(mailtoData.bcc) : [];

    // Let's try a simpler approach for multiple recipients
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draftData: any = {
      id: null,
      subject: mailtoData.subject,
      message: htmlContent,
      attachments: [],
    };

    // Add recipients - ensuring they are in the correct format
    // For multiple recipients, use array format; for single recipient, use string format
    if (toAddresses && toAddresses.length > 0) {
      if (toAddresses.length === 1) {
        draftData.to = toAddresses[0];
      } else {
        draftData.to = toAddresses.join(',');
      }
    }

    // Do the same for CC
    if (ccAddresses && ccAddresses.length > 0) {
      if (ccAddresses.length === 1) {
        draftData.cc = ccAddresses[0];
      } else {
        draftData.cc = ccAddresses.join(',');
      }
    } else {
      // Always include cc in the draft data, even if empty
      draftData.cc = '';
    }

    // And for BCC
    if (bccAddresses && bccAddresses.length > 0) {
      if (bccAddresses.length === 1) {
        draftData.bcc = bccAddresses[0];
      } else {
        draftData.bcc = bccAddresses.join(',');
      }
    } else {
      // Always include bcc in the draft data, even if empty
      draftData.bcc = '';
    }

    console.log('Creating draft with data:', {
      to: draftData.to,
      cc: draftData.cc,
      bcc: draftData.bcc,
      subject: draftData.subject,
      messageSample: htmlContent.substring(0, 100) + (htmlContent.length > 100 ? '...' : ''),
    });

    // Try to create the draft with retries
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`Attempt ${attempt} to create draft...`);

        const result = await trpcClient.drafts.create.mutate(draftData);

        if (result?.id) {
          console.log('Draft created successfully with ID:', result.id);
          return result.id;
        } else {
          console.error(
            `Draft creation failed (attempt ${attempt}):`,
            (result as { error?: unknown })?.error || 'Unknown error',
          );

          // If the error is related to "Invalid To header", try to fix the format for the next attempt
          if (attempt < MAX_RETRIES) {
            if (
              typeof result === 'object' &&
              result &&
              'error' in result &&
              String(result.error).includes('Invalid To header')
            ) {
              handleInvalidToHeader(draftData);
            }

            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * attempt)); // Exponential backoff
            continue;
          }
        }
      } catch (error) {
        console.error(`Error creating draft (attempt ${attempt}):`, error);
        console.error('Error details:', error instanceof Error ? error.message : String(error));

        // If the error is related to "Invalid To header", try to fix the format for the next attempt
        if (attempt < MAX_RETRIES) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (errorMessage.includes('Invalid To header')) {
            handleInvalidToHeader(draftData);
          }

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * attempt)); // Exponential backoff
          continue;
        }
      }
    }
  } catch (error) {
    console.error('Error creating draft from mailto:', error);
  }

  return null;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const baseUrl = import.meta.env.VITE_PUBLIC_APP_URL || new URL(request.url).origin;
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(`${baseUrl}/login`);

  const url = new URL(request.url);

  // Get the mailto parameter from the URL
  const mailto = url.searchParams.get('mailto');

  if (!mailto) return Response.redirect(`${baseUrl}/mail/compose`);

  // Parse the mailto URL
  const mailtoData = await parseMailtoUrl(mailto);

  // If parsing failed, redirect to empty compose
  if (!mailtoData) return Response.redirect(`${baseUrl}/mail/compose`);

  // Create a draft from the mailto data
  const draftId = await createDraftFromMailto(mailtoData);

  // If draft creation failed, redirect to empty compose with the parsed data as a fallback
  if (!draftId) {
    const fallbackUrl = new URL(`${baseUrl}/mail/compose`);
    if (mailtoData.to) fallbackUrl.searchParams.append('to', mailtoData.to);
    if (mailtoData.subject) fallbackUrl.searchParams.append('subject', mailtoData.subject);
    if (mailtoData.body) fallbackUrl.searchParams.append('body', mailtoData.body);
    if (mailtoData.cc) fallbackUrl.searchParams.append('cc', mailtoData.cc);
    if (mailtoData.bcc) fallbackUrl.searchParams.append('bcc', mailtoData.bcc);
    return Response.redirect(fallbackUrl.toString());
  }

  // Redirect to compose with the draft ID
  return Response.redirect(
    `${baseUrl}/mail/compose?draftId=${draftId}`,
  );
}
