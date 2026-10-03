import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";

/** Runs in an actual VS Code extension host, using the built extension bundle. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("oblien.openship-vscode");
  assert.ok(extension, "Openship extension was not discovered");
  await extension.activate();
  assert.ok(extension.isActive, "Bundled extension did not activate");
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of extension.packageJSON.contributes.commands) {
    assert.ok(commands.has(command.command), `Command was not registered: ${command.command}`);
  }
  await vscode.commands.executeCommand("openship.refresh");
  await vscode.commands.executeCommand("openship.stopLogs");
  assert.equal(extension.packageJSON.extensionKind[0], "workspace");
  assert.ok(
    Number(process.versions.node.split(".")[0]) >= 22,
    "The SDK requires a Node 22 extension host",
  );
  const schema = JSON.parse(
    await readFile(join(extension.extensionPath, "schemas/openship.schema.json"), "utf8"),
  );
  assert.ok(schema.properties.framework.enum.includes("nextjs"));
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "Missing test workspace");
  const uri = vscode.Uri.joinPath(folder.uri, "openship.json");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  let diagnostics: readonly vscode.Diagnostic[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length) break;
    await delay(100);
  }
  assert.ok(
    diagnostics.some(
      (item) => item.message.includes("nextjs") || item.message.includes("not accepted"),
    ),
    `Packaged schema did not validate openship.json: ${JSON.stringify(diagnostics)}`,
  );
  console.log(
    "Openship extension host smoke tests passed: activation, commands, Node runtime, and JSON schema diagnostics.",
  );
}
