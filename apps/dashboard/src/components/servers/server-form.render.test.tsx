// No DOM needed: renderToStaticMarkup runs no effects, and the form is pure
// until a button is clicked.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { ServerForm } from "./server-form";

vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: () => {} }) }));

/** `deployMode` defaults to "docker" — the compose/VPS install, where the API is a
 *  container and a host key path resolves inside it. Pass "desktop" for the shell. */
function render(
  props: Partial<React.ComponentProps<typeof ServerForm>> = {},
  deployMode = "docker",
) {
  return renderToStaticMarkup(
    <PlatformProvider deployMode={deployMode}>
      <I18nProvider>
        <ServerForm onSaved={() => {}} {...props} />
      </I18nProvider>
    </PlatformProvider>,
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

/** Every `name="…"`-less field is identified by its placeholder here. */
function placeholders(html: string) {
  return [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]).sort();
}

/**
 * The add-server modal used to be a second 443-line copy of this form, which is
 * how it drifted: its own toast keys, its own "22"/"root" placeholders, and no
 * inline failure message under Test Connection. Both chromes now render one set
 * of fields, and these tests fail if a variant starts growing its own.
 */
describe("ServerForm variants", () => {
  it("renders the same fields in both chromes", () => {
    const page = placeholders(render());
    const modal = placeholders(render({ variant: "modal", onCancel: () => {} }));
    expect(modal).toEqual(page);
    // Sanity-check the list is the real one and not two empty arrays. Advanced
    // and the key fields are collapsed on a fresh password-auth form.
    expect(page).toContain("123.45.67.89");
    expect(page).toContain("Enter server password");
  });

  it("renders the same fields in both chromes with key auth and advanced open", () => {
    // Prefilled jump host / args expand Advanced, so this covers the branches
    // the default render hides.
    const server = {
      id: "s1",
      sshHost: "10.0.0.1",
      sshPort: 22,
      sshUser: "deploy",
      sshAuthMethod: "key",
      sshKeyPath: "~/.ssh/id_ed25519",
      sshJumpHost: "user@bastion",
      sshArgs: "-vvv",
    } as unknown as React.ComponentProps<typeof ServerForm>["server"];

    const page = placeholders(render({ server }));
    const modal = placeholders(render({ server, variant: "modal", onCancel: () => {} }));
    expect(modal).toEqual(page);
    expect(page).toContain("-o StrictHostKeyChecking=no");
    expect(page).toContain("user@bastion.example.com");
    expect(page).toContain("/root/.ssh/id_ed25519");
  });

  /**
   * The key path is read off the filesystem of the machine running the API, and
   * `resolveSafeSshKeyPath` (apps/api) rejects anything not absolute. The field
   * used to suggest `~/.ssh/id_rsa`, which can only ever fail — so the placeholder
   * shape and the hint about WHOSE filesystem it is are both load-bearing.
   */
  it("asks for an absolute path on the Openship host, not a tilde path", () => {
    // A stored host path opens the key tab in "Host path" mode (a paste/upload
    // form has no path field). renderToStaticMarkup can't click the sub-toggle.
    const server = {
      id: "s1",
      sshHost: "10.0.0.1",
      sshAuthMethod: "key",
      sshKeyPath: "/root/.ssh/id_ed25519",
    } as unknown as React.ComponentProps<typeof ServerForm>["server"];

    const html = render({ server });
    expect(placeholders(html)).not.toContain("~/.ssh/id_rsa");
    expect(text(html)).toContain("Absolute path to the private key on the machine running Openship.");
  });

  /**
   * Browse opens a NATIVE dialog, which only makes sense in the desktop shell —
   * there the API reads the key off this same machine. renderToStaticMarkup runs
   * no effects, so `canBrowseKey` stays false: this is exactly the web/VPS render,
   * where the browser cannot reach the server's filesystem and the path is typed.
   */
  it("offers no Browse button outside the desktop shell", () => {
    const server = {
      id: "s1",
      sshHost: "10.0.0.1",
      sshAuthMethod: "key",
    } as unknown as React.ComponentProps<typeof ServerForm>["server"];

    expect(text(render({ server }))).not.toContain("Browse");
  });

  /**
   * Why the paste/upload sub-mode exists: on a remote/VPS instance the operator's
   * key lives on THEIR laptop, not the API host, so a host path points at nothing.
   * Key auth with neither a stored path nor stored material opens in paste/upload —
   * a textarea the browser fills client-side + an upload button — not the path field.
   */
  it("defaults key auth to paste/upload when there is no host path", () => {
    const server = {
      id: "s1",
      sshHost: "10.0.0.1",
      sshAuthMethod: "key",
    } as unknown as React.ComponentProps<typeof ServerForm>["server"];

    const html = render({ server });
    const out = text(html);
    expect(out).toContain("Upload key file");
    expect(out).toContain("Pasted keys are encrypted at rest and never leave the server.");
    // The paste textarea (placeholder lives inside the tag, so check raw html),
    // and NOT the host-path input.
    expect(html).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(placeholders(html)).not.toContain("/root/.ssh/id_ed25519");
  });

  /**
   * A host path is read by `readFileSync` inside the API process. On a compose
   * install that process is a container that mounts no ~/.ssh, so a path an
   * operator can `cat` on their VPS resolves to nothing and the save fails as
   * "Invalid auth configuration". The option is therefore desktop-only — the one
   * mode where the browser and the API share a filesystem.
   */
  describe("host-path mode is offered only where a path can resolve", () => {
    const keyAuth = {
      id: "s1",
      sshHost: "10.0.0.1",
      sshAuthMethod: "key",
    } as unknown as React.ComponentProps<typeof ServerForm>["server"];

    it("offers no host-path option on a VPS install", () => {
      for (const mode of ["docker", "bare"]) {
        const out = text(render({ server: keyAuth }, mode));
        expect(out, mode).not.toContain("Host path");
        // Paste/upload is the whole control now, so the toggle's own label goes
        // with it — the textarea and its upload button are what remain.
        expect(out, mode).not.toContain("Paste / Upload");
        expect(out, mode).toContain("Upload key file");
      }
    });

    it("offers both sub-modes in the desktop shell", () => {
      const out = text(render({ server: keyAuth }, "desktop"));
      expect(out).toContain("Paste / Upload");
      expect(out).toContain("Host path");
      expect(out).toContain("Upload key file");
    });

    /**
     * Grandfathering, and it is load-bearing: hiding the toggle for a row that
     * already stores a path would drop it into paste mode, where a save sends
     * `sshKeyPath: null` with no material to replace it. Renaming such a server
     * would strip the only credential it has.
     */
    it("keeps the toggle for a row that already stores a path, on any install", () => {
      const stored = {
        ...keyAuth,
        sshKeyPath: "/root/.ssh/id_ed25519",
      } as unknown as React.ComponentProps<typeof ServerForm>["server"];

      for (const mode of ["docker", "bare", "desktop"]) {
        const html = render({ server: stored }, mode);
        expect(text(html), mode).toContain("Host path");
        // And it opens ON the path, showing the operator what is stored.
        expect(placeholders(html), mode).toContain("/root/.ssh/id_ed25519");
      }
    });
  });

  /**
   * The API never returns key material — only a boolean that one is stored. Edit
   * mode must say so and let a blank save keep it, or reopening a server and saving
   * would silently wipe its key.
   */
  it("tells the operator a key is already stored when editing a pasted-key server", () => {
    const server = {
      id: "s1",
      sshHost: "10.0.0.1",
      sshAuthMethod: "key",
      hasStoredKeyMaterial: true,
    } as unknown as React.ComponentProps<typeof ServerForm>["server"];

    expect(render({ server })).toContain("A key is stored");
  });

  it("gives the page variant the setup-flow header and label", () => {
    const out = text(render());
    expect(out).toContain("SSH Connection");
    expect(out).toContain("Save & Continue to Setup");
  });

  it("gives the modal variant its own title and a save-and-return label", () => {
    const out = text(render({ variant: "modal", onCancel: () => {} }));
    expect(out).toContain("Add your server");
    // "& Continue to Setup" is a lie in a modal: it closes and hands the row back.
    expect(out).not.toContain("Save & Continue to Setup");
    expect(out).toContain("Save server");
  });

  it("only the modal variant is dismissable in place", () => {
    expect(render({ variant: "modal", onCancel: () => {} })).toContain("lucide-x");
    expect(render()).not.toContain("lucide-x");
  });

  it("lets the caller override the primary label in either chrome", () => {
    expect(text(render({ submitLabel: "Attach box" }))).toContain("Attach box");
    expect(
      text(render({ variant: "modal", onCancel: () => {}, submitLabel: "Attach box" })),
    ).toContain("Attach box");
  });
});
