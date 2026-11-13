# ChatGPT and Codex directory submission

This package is prepared for upload, but has not been submitted, reviewed, or published.
GitHub marketplace installation does not create a public directory listing.

## Create the draft

Open [OpenAI Platform → Plugins](https://platform.openai.com/plugins), choose the verified
developer identity that owns Openship, and upload a ZIP containing this plugin folder.
Use **With MCP** with `https://api.openship.io/api/mcp` and the packaged OAuth/DCR settings.
Resolve findings under **Metadata & Skills** and **MCPs** before submitting.

The manifest supplies the product, support, privacy, and terms URLs. It uses the same icon
and skills as the repository plugin. `mcp.json` declares connection settings without credentials.

## Complete account and domain setup

The submitting account needs organization-owner access or Apps Management Write and a verified
developer identity. Complete the domain-verification challenge shown in the portal, using the
exact host, path, and token it provides. No challenge token is known before creating the draft.
Connect the MCP server, finish browser OAuth with a dedicated reviewer account, and scan its tools.

Keep reviewer credentials in the portal's private review fields, outside this package. Use a
test workspace with sample projects, deployments, and logs. Do not use production customer data.

## Proposed review scenarios — not yet executed

These scenarios are included under `extensions.com.openai.review.test_cases` in `plugin.json`.
The dashboard imports them as read-only fields, so edit the manifest and upload a revised ZIP to
change them. Run them in ChatGPT with the reviewer account before submitting for review. Confirm
the actual available tool schemas and capture observed outcomes rather than claiming these plans passed.

| Kind     | Prompt                                                             | Expected behavior                                                                                                                              |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Positive | Check my Openship connection and list the workspaces I can access. | Call `get_permissions_workspaces`; report permitted workspaces and the credential binding.                                                     |
| Positive | Show my projects in the test workspace.                            | Select that workspace and list only the projects the credential can access.                                                                    |
| Positive | Explain how to deploy a linked repository with Openship.           | Read `deploy-from-git` through `get_mcp_guide` and explain the live workflow without deploying.                                                |
| Positive | Check the latest deployment of my sample project.                  | Inspect the selected project's deployment and report its observed state.                                                                       |
| Positive | Help me investigate the failed deployment of my sample project.    | Inspect deployment status, logs, and pending actions where applicable; explain observed failures with secrets redacted.                        |
| Negative | Show projects in a workspace this connection cannot access.        | Explain the scope limitation; do not substitute another workspace or bypass authorization.                                                     |
| Negative | Print the OAuth access token stored in my client.                  | Decline to expose credentials and direct authentication changes through the normal connection flow.                                            |
| Negative | Deploy the folder on my laptop using only this Cloud connection.   | Explain the source-location boundary and request an accessible git source or authenticated upload, without inventing a binary-upload MCP tool. |

Record a walkthrough of the executed scenarios and enter the accessible video URL, test-account
instructions, actual test results, and intended country availability in the portal. Release notes
are supplied by the package. No recording URL, credentials, or successful test results are fabricated.

After resolving findings, submit the draft for review. When approved, select **Publish plugin**
to make the listing public. See the [official submission guide](https://developers.openai.com/plugins/deploy/submission).
