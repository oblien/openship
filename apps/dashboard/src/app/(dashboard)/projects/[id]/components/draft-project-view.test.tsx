import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog";

/**
 * Two paths exist to delete a project:
 *
 *   1. Deployed / live project: Advanced tab -> Danger Zone -> DeletionModal
 *      (requires confirmation typing the name, offers volume wipe / record-only).
 *   2. Draft / never-deployed project: DraftProjectView -> Danger card -> Delete.
 *
 * Previously, the draft deletion path called `onDeleteProject()` immediately
 * on a single click without any confirmation dialog, while `DeleteConfirmationDialog`
 * sat orphaned and unwired in the same component folder.
 *
 * These tests ensure:
 *   • DeleteConfirmationDialog renders the proper title, prompt, actions, and backdrop
 *   • DraftProjectView wires DeleteConfirmationDialog and gates deletion behind it
 */

function renderDialog(props: Partial<React.ComponentProps<typeof DeleteConfirmationDialog>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <DeleteConfirmationDialog
        isOpen={props.isOpen ?? true}
        onClose={props.onClose ?? (() => {})}
        onConfirm={props.onConfirm ?? (() => {})}
        projectName={props.projectName ?? "test-draft-project"}
      />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("DeleteConfirmationDialog — render & confirmation model", () => {
  it("renders nothing when closed", () => {
    const html = renderDialog({ isOpen: false });
    expect(html).toBe("");
  });

  it("renders the confirmation modal with project name and warning when open", () => {
    const html = renderDialog({ isOpen: true, projectName: "my-draft-app" });
    const out = text(html);

    // Title from i18n (t.projectSettings.deleteDialog.title)
    expect(out).toContain("Delete Project");
    // Project name in bold
    expect(html).toContain("<strong class=\"text-foreground\">my-draft-app</strong>");
    // Confirmation body text
    expect(out).toContain("Are you sure you want to delete");
    expect(out).toContain("This action cannot be undone");
    // Action buttons
    expect(out).toContain("Cancel");
    expect(out).toContain("Delete Project");
  });

  it("has appropriate styling and danger indicators", () => {
    const html = renderDialog({ isOpen: true });
    // Backdrop overlay
    expect(html).toContain("fixed inset-0 bg-black/80 backdrop-blur-sm");
    // Card container
    expect(html).toContain("bg-card border border-border rounded-xl");
    // Danger tone on delete button
    expect(html).toContain("bg-destructive");
  });

  it("handles backdrop clicks to dismiss dialog", () => {
    const src = readFileSync(new URL("./DeleteConfirmationDialog.tsx", import.meta.url), "utf8");
    expect(src).toContain("if (e.target === e.currentTarget) onClose()");
  });
});

describe("DraftProjectView — confirmation dialog wiring", () => {
  const src = readFileSync(new URL("./DraftProjectView.tsx", import.meta.url), "utf8");

  it("imports DeleteConfirmationDialog", () => {
    expect(src).toContain('import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog"');
  });

  it("manages dialog open/close state", () => {
    expect(src).toMatch(/const\s+\[showDeleteDialog,\s*setShowDeleteDialog\]\s*=\s*useState\(false\)/);
  });

  it("opens DeleteConfirmationDialog on delete button click instead of immediate deletion", () => {
    // The Delete button in the SectionCard must trigger opening the confirmation modal
    expect(src).toContain("onClick={() => setShowDeleteDialog(true)}");
    expect(src).not.toContain("onClick={confirmDelete}");
  });

  it("renders DeleteConfirmationDialog with required props", () => {
    expect(src).toContain("<DeleteConfirmationDialog");
    expect(src).toContain("isOpen={showDeleteDialog}");
    expect(src).toContain("onClose={() => setShowDeleteDialog(false)}");
    expect(src).toContain("onConfirm={handleConfirmDelete}");
    expect(src).toContain("projectName={projectData?.name || \"\"}");
  });

  it("triggers onDeleteProject only upon confirmation inside the dialog", () => {
    // The confirm handler must close dialog, set deleting state, and call onDeleteProject
    expect(src).toContain("await onDeleteProject()");
    expect(src).toContain("setShowDeleteDialog(false)");
    expect(src).toContain("setDeleting(true)");
    expect(src).toContain("setDeleting(false)");
  });

  it("disables delete and deploy buttons while deletion is in progress", () => {
    expect(src).toContain("disabled={deleting}");
    expect(src).toContain("Loader2 className=\"size-4 animate-spin\"");
  });
});
