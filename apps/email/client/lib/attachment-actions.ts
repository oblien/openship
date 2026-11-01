import { toast } from "sonner";
import { getInlineAttachmentType } from "./inline-attachment";
import { escapeHtml, getOfficePreviewKind, renderOfficePreview } from "./office-preview";

export const downloadAttachment = async (attachment: {
  body: string;
  mimeType: string;
  filename: string;
  attachmentId: string;
}) => {
  try {
    const attachmentData = attachment.body;

    const byteCharacters = atob(attachmentData);
    const byteNumbers: number[] = Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: attachment.mimeType });

    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Error downloading attachment:", error);
    toast.error("Failed to download attachment");
  }
};

export const openAttachmentViewer = () => {
  const width = 800;
  const height = 600;
  const left = (window.screen.width - width) / 2;
  const top = (window.screen.height - height) / 2;
  return window.open(
    "",
    "attachment-viewer",
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,location=no,menubar=no`,
  );
};

// A generated preview is still built from sender bytes, so it renders in a
// sandboxed frame with an opaque origin and no scripts, never in the webmail origin.
const sandboxedViewer = (title: string, html: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>html,body,iframe{display:block;width:100%;height:100%;margin:0;border:0}</style></head><body><iframe sandbox srcdoc="${escapeHtml(html)}"></iframe></body></html>`;

/** What the viewer may load for this attachment, or null when it must be downloaded. */
const viewerBlob = async (
  attachment: { mimeType: string; filename: string },
  bytes: Uint8Array<ArrayBuffer>,
) => {
  const officeKind = getOfficePreviewKind(attachment.mimeType, attachment.filename);
  if (officeKind) {
    // Unparseable, encrypted or disguised files download instead of opening raw.
    const preview = await renderOfficePreview(officeKind, bytes, attachment.filename).catch(
      () => null,
    );
    return preview
      ? new Blob([sandboxedViewer(attachment.filename, preview)], { type: "text/html" })
      : null;
  }
  const inlineType = getInlineAttachmentType(attachment.mimeType);
  return inlineType ? new Blob([bytes], { type: inlineType }) : null;
};

export const openAttachment = async (
  attachment: {
    body: string;
    mimeType: string;
    filename: string;
    attachmentId: string;
  },
  pendingPopup?: Window | null,
) => {
  try {
    const attachmentData = attachment.body;

    const byteCharacters = atob(attachmentData);
    const byteNumbers: number[] = Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = await viewerBlob(attachment, byteArray);
    if (!blob) {
      pendingPopup?.close();
      await downloadAttachment(attachment);
      return;
    }
    const url = window.URL.createObjectURL(blob);

    const popup = pendingPopup === undefined ? openAttachmentViewer() : pendingPopup;

    if (popup) {
      popup.location.href = url;
      popup.focus();
      // Clean up the URL after a short delay to ensure the browser has time to load it
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } else {
      // Popup was blocked: nothing will ever load the URL, so revoke it now
      // instead of leaking the blob until the tab closes.
      window.URL.revokeObjectURL(url);
    }
  } catch (error) {
    pendingPopup?.close();
    console.error("Error opening attachment:", error);
    toast.error("Failed to open attachment");
  }
};
