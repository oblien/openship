import * as emailAddresses from 'email-addresses';
import type { Sender } from '@/types';
import DOMPurify from 'dompurify';
import Color from 'color';

export const fixNonReadableColors = (
  rootElement: HTMLElement,
  options?: { minContrast?: number; defaultBackground?: string },
) => {
  const { minContrast = 3.5, defaultBackground = '#ffffff' } = options || {};
  const elements = Array.from<HTMLElement>(rootElement.querySelectorAll('*'));
  elements.unshift(rootElement);

  for (const el of elements) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Skip if the color is a CSS variable or special value
    if (
      style.color.startsWith('var(') ||
      style.color === 'transparent' ||
      style.color === 'inherit'
    ) {
      continue;
    }

    try {
      const textColor = Color(style.color);
      const effectiveBg = getEffectiveBackgroundColor(el, defaultBackground);

      const blendedText =
        textColor.alpha() < 1 ? effectiveBg.mix(textColor, effectiveBg.alpha()) : textColor;
      const contrast = blendedText.contrast(effectiveBg);

      if (contrast < minContrast) {
        const blackContrast = Color('#000000').contrast(effectiveBg);
        const whiteContrast = Color('#ffffff').contrast(effectiveBg);
        el.style.color = blackContrast >= whiteContrast ? '#000000' : '#ffffff';
      }
    } catch (error) {
      console.error('Error fixing non-readable colors:', error);
    }
  }
};

const getEffectiveBackgroundColor = (element: HTMLElement, defaultBackground: string) => {
  let current: HTMLElement | null = element;
  while (current) {
    const bg = Color(getComputedStyle(current).backgroundColor);
    if (bg.alpha() >= 1) return bg.rgb();
    current = current.parentElement;
  }
  return Color(defaultBackground);
};

type ListUnsubscribeAction =
  | { type: 'get'; url: string; host: string }
  | { type: 'post'; url: string; body: string; host: string }
  | { type: 'email'; emailAddress: string; subject: string; host: string };

const processHttpUrl = (url: URL, listUnsubscribePost?: string) => {
  if (listUnsubscribePost) {
    return {
      type: 'post' as const,
      url: url.toString(),
      body: listUnsubscribePost,
      host: url.hostname,
    };
  }
  return { type: 'get' as const, url: url.toString(), host: url.hostname };
};

// Relevant specs:
// - https://www.ietf.org/rfc/rfc2369.txt (list-unsubscribe)
// - https://www.ietf.org/rfc/rfc8058.txt (list-unsubscribe-post)
export const getListUnsubscribeAction = ({
  listUnsubscribe,
  listUnsubscribePost,
}: {
  listUnsubscribe: string;
  listUnsubscribePost?: string;
}): ListUnsubscribeAction | null => {
  const match = listUnsubscribe.match(/<([^>]+)>/);

  if (!match || !match[1]) {
    // NOTE: Some senders do not implement a spec-compliant list-unsubscribe header (e.g. Linear).
    // We can be a bit more lenient and try to parse the header as a URL, Gmail also does this.
    try {
      const url = new URL(listUnsubscribe);
      if (url.protocol.startsWith('http')) {
        return processHttpUrl(url, listUnsubscribePost);
      }
      return null;
    } catch {
      return null;
    }
  }

  // NOTE: List-Unsubscribe can contain multiple URLs, but the spec says to process the first one we can.
  const url = new URL(match[1]);

  if (url.protocol.startsWith('http')) {
    return processHttpUrl(url, listUnsubscribePost);
  }

  if (url.protocol === 'mailto:') {
    const emailAddress = url.pathname;
    const subject = new URLSearchParams(url.search).get('subject') || '';

    return { type: 'email', emailAddress, subject, host: url.hostname };
  }

  return null;
};

const FALLBACK_SENDER = {
  name: '',
  email: 'no-sender@unknown',
};

export const parseFrom = (fromHeader: string) => {
  const parsedSender = emailAddresses.parseFrom(fromHeader);
  if (!parsedSender) return FALLBACK_SENDER;

  // Technically the "From" header can include multiple email addresses according to
  // RFC 2822, but this isn't used in practice. So we only show the first.
  const firstSender = parsedSender[0];
  if (!firstSender) return FALLBACK_SENDER;

  if (firstSender.type === 'group') {
    const name = firstSender.name || FALLBACK_SENDER.name;
    const firstAddress = firstSender.addresses?.[0]?.address;
    const email = firstAddress || FALLBACK_SENDER.email;
    return { name, email };
  }

  const name = firstSender.name || firstSender.address;

  const email = firstSender.address || FALLBACK_SENDER.email;

  return { name, email };
};

export const parseAddressList = (header: string): Sender[] => {
  const parsedAddressList = emailAddresses.parseAddressList(header);
  if (!parsedAddressList) return [FALLBACK_SENDER];

  return parsedAddressList?.flatMap((address) => {
    if (address.type === 'group') {
      return (address.addresses || []).flatMap((address) => ({
        name: address.name || FALLBACK_SENDER.name,
        email: address.address || FALLBACK_SENDER.email,
      }));
    }

    return {
      name: address.name || FALLBACK_SENDER.name,
      email: address.address || FALLBACK_SENDER.email,
    };
  });
};

// Helper function to clean email addresses by removing angle brackets
export const cleanEmailAddresses = (emails: string | undefined) => {
  if (!emails || emails.trim() === '') return undefined;
  // Split by commas and clean each address individually
  return emails
    .split(',')
    .map((email) => email.trim().replace(/^<|>$/g, ''))
    .filter(Boolean); // Remove any empty entries
};

// Format recipients for display or sending
export const formatRecipients = (recipients: string[] | undefined) => {
  if (!recipients || recipients.length === 0) return undefined;
  return recipients.join(', ');
};

/**
 * Format recipients for MIME message creation
 * Handles both string and array formats for recipients
 */
export const formatMimeRecipients = (recipients: string | string[]) => {
  if (Array.isArray(recipients)) {
    return recipients.map((recipient) => ({ addr: recipient }));
  } else if (typeof recipients === 'string' && recipients.trim() !== '') {
    return recipients.split(',').map((recipient) => ({ addr: recipient.trim() }));
  }
  return null;
};

export const wasSentWithTLS = (receivedHeaders: string[]) => {
  const tlsIndicators = [
    /using\s+TLS/i,
    /with\s+ESMTPS/i,
    /version=TLS[0-9_.]+/i,
    /TLSv[0-9.]+/i,
    /cipher=[A-Z0-9-]+/i,
  ];

  for (const header of receivedHeaders.reverse()) {
    for (const indicator of tlsIndicators) {
      if (indicator.test(header)) {
        return true;
      }
    }
  }

  return false;
};

// cleans up html string for xss attacks and returns html
export const cleanHtml = (html: string) => {
  if (!html) return '<p><em>No email content available</em></p>';

  try {
    return DOMPurify.sanitize(html);
  } catch (error) {
    console.warn('DOMPurify Failed or not Available, falling back to Default HTML ', error);
    return '<p><em>No email content available</em></p>';
  }
};
