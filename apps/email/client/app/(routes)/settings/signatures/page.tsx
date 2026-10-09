import { useEffect, useRef, useState } from "react";
import { EditorContent } from "@tiptap/react";
import { useMutation } from "@tanstack/react-query";
import { sanitizeSignatureHtml } from "@zero/server/signatures";
import useComposeEditor from "@/hooks/use-compose-editor";
import { useSettings } from "@/hooks/use-settings";
import { useTRPC } from "@/providers/query-provider";
import { SettingsCard } from "@/components/settings/settings-card";
import { Toolbar } from "@/components/create/toolbar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";
import { toast } from "sonner";

export default function SignaturesPage() {
  const { data, refetch } = useSettings();
  const trpc = useTRPC();
  const save = useMutation(trpc.settings.save.mutationOptions());
  const [enabled, setEnabled] = useState(false);
  const [preview, setPreview] = useState("");
  const [htmlMode, setHtmlMode] = useState(false);
  const [htmlInput, setHtmlInput] = useState("");
  const initialized = useRef(false);
  const editor = useComposeEditor({
    isReadOnly: !data || save.isPending,
    onLengthChange: () => setPreview(sanitizeSignatureHtml(editor?.getHTML() ?? "")),
    placeholder: m["pages.settings.signatures.richTextPlaceholder"](),
    ariaLabel: m["pages.settings.signatures.signatureContent"](),
  });

  useEffect(() => {
    if (!editor || !data || initialized.current) return;
    initialized.current = true;
    const html = sanitizeSignatureHtml(data.settings.signature);
    editor.commands.setContent(html);
    setPreview(html);
    setHtmlInput(html);
    setEnabled(data.settings.signatureEnabled);
  }, [editor, data]);

  async function onSave() {
    try {
      const result = await save.mutateAsync({
        ...data?.settings,
        signature: sanitizeSignatureHtml(htmlMode ? htmlInput : (editor?.getHTML() ?? "")),
        signatureEnabled: enabled,
      });
      editor?.commands.setContent(result.settings.signature);
      setPreview(result.settings.signature);
      setHtmlInput(result.settings.signature);
      await refetch();
      toast.success(m["pages.settings.signatures.signatureSaved"]());
    } catch {
      toast.error(m["common.settings.failedToSave"]());
    }
  }

  return (
    <SettingsCard
      title={m["pages.settings.signatures.title"]()}
      description={m["pages.settings.signatures.description"]()}
      footer={
        <Button onClick={onSave} disabled={!data || !editor || save.isPending}>
          {save.isPending ? m["common.actions.saving"]() : m["common.actions.saveChanges"]()}
        </Button>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="signature-enabled">
            {m["pages.settings.signatures.enableSignature"]()}
          </Label>
          <p className="text-muted-foreground text-sm">
            {m["pages.settings.signatures.enableSignatureDescription"]()}
          </p>
        </div>
        <Switch
          id="signature-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={!data || save.isPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="signature-editor-type">{m["pages.settings.signatures.editorType"]()}</Label>
        <select
          id="signature-editor-type"
          className="bg-background rounded-md border p-2"
          value={htmlMode ? "html" : "rich"}
          disabled={!data || save.isPending}
          onChange={(event) => {
            if (event.target.value === "html") {
              setHtmlInput(editor?.getHTML() ?? "");
              setHtmlMode(true);
            } else {
              const html = sanitizeSignatureHtml(htmlInput);
              editor?.commands.setContent(html);
              setPreview(html);
              setHtmlMode(false);
            }
          }}
        >
          <option value="rich">{m["pages.settings.signatures.richText"]()}</option>
          <option value="html">{m["pages.settings.signatures.plainText"]()}</option>
        </select>
      </div>
      <div className="space-y-3">
        <Label id="signature-content-label">
          {m["pages.settings.signatures.signatureContent"]()}
        </Label>
        {htmlMode ? (
          <Textarea
            aria-labelledby="signature-content-label"
            value={htmlInput}
            disabled={!data || save.isPending}
            className="min-h-32 font-mono"
            onChange={(event) => {
              setHtmlInput(event.target.value);
              setPreview(sanitizeSignatureHtml(event.target.value));
            }}
          />
        ) : (
          <>
            <Toolbar editor={editor} />
            <EditorContent
              editor={editor}
              aria-labelledby="signature-content-label"
              className="min-h-32 rounded-lg border p-4"
            />
          </>
        )}
      </div>
      <div className="space-y-3">
        <h2 className="font-medium">{m["pages.settings.signatures.signaturePreview"]()}</h2>
        <div
          className="prose dark:prose-invert max-w-full rounded-lg border p-4"
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      </div>
    </SettingsCard>
  );
}
