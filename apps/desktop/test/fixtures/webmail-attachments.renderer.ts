import { openAttachment, openAttachmentViewer } from "../../../email/client/lib/attachment-actions";

let viewer: Window | null = null;

Object.assign(window, {
  openMailAttachment: (attachment: Parameters<typeof openAttachment>[0], blocked = false) => {
    viewer = blocked ? null : openAttachmentViewer();
    return openAttachment(attachment, viewer);
  },
  viewerClosed: () => viewer?.closed ?? true,
  pngAttachment: () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    return canvas.toDataURL("image/png").split(",")[1];
  },
});
