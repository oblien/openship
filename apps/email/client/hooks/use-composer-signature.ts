import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { sanitizeSignatureHtml } from "@zero/server/signatures";

export function useComposerSignature(
  editor: Editor | null,
  settings: { signature: string; signatureEnabled?: boolean } | undefined,
  initialMessage: string,
  draftId?: string | null,
) {
  const initialized = useRef(false);
  useEffect(() => {
    if (!editor || !settings || initialized.current) return;
    initialized.current = true;
    // Drafts already contain the user's chosen body, including any signature.
    if (draftId || initialMessage.trim() || !settings.signatureEnabled) return;
    const signature = sanitizeSignatureHtml(settings.signature);
    if (!signature.trim()) return;
    // Append if the user started typing before settings loaded; never replace it.
    editor.commands.insertContentAt(editor.state.doc.content.size, `<p></p>${signature}`, {
      updateSelection: false,
    });
  }, [editor, settings, initialMessage, draftId]);
}
