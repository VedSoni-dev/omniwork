"use strict";
// Workspace confinement for the file tools. The regression: confine() compared
// text paths, so a symlink committed inside a repo (docs/x -> ~/.ssh) carried
// reads, writes and listings outside the workspace — and the approval preview
// and ACP diff read through it too, sending the outside file to the client.
//
// Run: node test/confine.js
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { executeToolResult, previewEdit, writeConfined } = require("../electron/tools");
const { Agent } = require("../electron/agent");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-confine-"));
const ws = path.join(root, "ws");
const outside = path.join(root, "outside");
fs.mkdirSync(ws); fs.mkdirSync(outside);
const SECRET = "TOP SECRET — outside the workspace";
const secretFile = path.join(outside, "secret.txt");
fs.writeFileSync(secretFile, SECRET);
fs.writeFileSync(path.join(ws, "inside.txt"), "hello");
try {
  fs.symlinkSync(secretFile, path.join(ws, "link-file"));
  fs.symlinkSync(outside, path.join(ws, "link-dir"), "dir");
  fs.symlinkSync("inside.txt", path.join(ws, "inner-link"));
  fs.symlinkSync(path.join(outside, "missing.txt"), path.join(ws, "dangling"));
  fs.symlinkSync(ws, path.join(root, "alias"), "dir");
} catch (e) {
  console.log(`- symlinks unavailable here (${e.code}); skipping`);
  process.exit(0);
}

const run = (name, args, workspace = ws) => executeToolResult(name, args, { workspace });
const secretIntact = () => fs.readFileSync(secretFile, "utf8") === SECRET;

// A gateway that replays a fixed list of assistant messages.
function gateway(script) {
  let i = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const message = script[Math.min(i++, script.length - 1)];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() })));
}
const toolCall = (name, args) => ({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] });

(async () => {
  // ── reads, listings and writes through links that leave the workspace ──
  const readLink = await run("read_file", { path: "link-file" });
  check("read_file refuses a symlink to a file outside", !readLink.ok && !readLink.text.includes("TOP SECRET"));
  const readThroughDir = await run("read_file", { path: "link-dir/secret.txt" });
  check("read_file refuses a path through a symlinked directory", !readThroughDir.ok && !readThroughDir.text.includes("TOP SECRET"));
  const listed = await run("list_dir", { path: "link-dir" });
  check("list_dir refuses a symlinked directory outside", !listed.ok && !listed.text.includes("secret.txt"));

  const writeThroughDir = await run("write_file", { path: "link-dir/planted.txt", content: "x" });
  check("write_file refuses to create a file through a symlinked directory", !writeThroughDir.ok && !fs.existsSync(path.join(outside, "planted.txt")));
  const writeDeep = await run("write_file", { path: "link-dir/sub/deeper.txt", content: "x" });
  check("…including new subdirectories under it", !writeDeep.ok && !fs.existsSync(path.join(outside, "sub")));
  const writeLink = await run("write_file", { path: "link-file", content: "overwritten" });
  check("write_file refuses a symlink to a file outside", !writeLink.ok && secretIntact());
  const editLink = await run("edit_file", { path: "link-file", old_string: "TOP", new_string: "NOT" });
  check("edit_file refuses a symlink to a file outside", !editLink.ok && secretIntact());
  const writeDangling = await run("write_file", { path: "dangling", content: "x" });
  check("write_file refuses a dangling symlink rather than creating its target", !writeDangling.ok && !fs.existsSync(path.join(outside, "missing.txt")));

  // ── plain escapes still fail, and the lexical check isn't over-eager ──
  const dotdot = await run("write_file", { path: "../escape.txt", content: "x" });
  check("a .. escape is refused", !dotdot.ok && !fs.existsSync(path.join(root, "escape.txt")));
  const absOut = await run("read_file", { path: secretFile });
  check("an absolute path outside is refused", !absOut.ok && !absOut.text.includes("TOP SECRET"));
  const absIn = await run("read_file", { path: path.join(ws, "inside.txt") });
  check("an absolute path inside is allowed", absIn.ok && absIn.text.startsWith("hello"));
  const dotName = await run("write_file", { path: "..not-a-parent", content: "ok" });
  check("a file whose name starts with '..' is not mistaken for an escape", dotName.ok && fs.existsSync(path.join(ws, "..not-a-parent")));

  // ── links that stay inside, new files, and a workspace reached by a link ──
  const innerRead = await run("read_file", { path: "inner-link" });
  check("read_file follows a symlink that stays inside", innerRead.ok && innerRead.text.startsWith("hello"));
  const innerWrite = await run("write_file", { path: "inner-link", content: "changed" });
  check("write_file never writes through a symlink, even one inside", !innerWrite.ok && /symlink/i.test(innerWrite.text) && fs.readFileSync(path.join(ws, "inside.txt"), "utf8") === "hello");
  const fresh = await run("write_file", { path: "new/sub/file.txt", content: "made" });
  check("write_file creates new files and directories inside", fresh.ok && fs.readFileSync(path.join(ws, "new/sub/file.txt"), "utf8") === "made");
  const viaAlias = await run("read_file", { path: "inside.txt" }, path.join(root, "alias"));
  check("a workspace opened through a symlink still reads its own files", viaAlias.ok && viaAlias.text.startsWith("hello"));
  const aliasEscape = await run("read_file", { path: "link-file" }, path.join(root, "alias"));
  check("…and still refuses links out of it", !aliasEscape.ok && !aliasEscape.text.includes("TOP SECRET"));

  // ── the write itself refuses a link swapped in after the check ──
  let threw = false;
  try { writeConfined(path.join(ws, "link-file"), "raced"); } catch { threw = true; }
  check("the final write does not follow a symlink (O_NOFOLLOW)", process.platform === "win32" || (threw && secretIntact()));

  // ── previews go through the same check ──
  check("previewEdit shows nothing for a write through a link outside", previewEdit(ws, "write_file", { path: "link-file", content: "x" }) === null);
  check("previewEdit shows nothing for an edit through a link outside", previewEdit(ws, "edit_file", { path: "link-file", old_string: "TOP", new_string: "NOT" }) === null);
  const okPreview = previewEdit(ws, "edit_file", { path: "new/sub/file.txt", old_string: "made", new_string: "remade" });
  check("previewEdit still diffs a normal file", okPreview && okPreview.oldText === "made" && okPreview.newText === "remade");

  {
    const gw = await gateway([toolCall("write_file", { path: "link-file", content: "x" }), { content: "done" }]);
    let preview = "unset";
    const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: "test", model: "m", workspace: ws, canSpawn: false, streaming: false, approvalMode: "ask",
      approver: async (_id, _name, _args, p) => { preview = p; return false; }, emit: () => {} });
    await agent.send("write it");
    check("the approval prompt never shows a file outside the workspace", preview === null || !JSON.stringify(preview).includes("TOP SECRET"));
    gw.close();
  }

  // ── undo does not follow a link swapped in after the turn ──
  {
    const gw = await gateway([toolCall("write_file", { path: "undo-me.txt", content: "agent" }), { content: "done" }]);
    const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: "test", model: "m", workspace: ws, canSpawn: false, streaming: false, emit: () => {} });
    fs.writeFileSync(path.join(ws, "undo-me.txt"), "original");
    await agent.send("write it");
    fs.rmSync(path.join(ws, "undo-me.txt"));
    fs.symlinkSync(secretFile, path.join(ws, "undo-me.txt"));
    agent.undo();
    check("undo refuses to restore through a symlink swapped in after the turn", secretIntact());
    gw.close();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ CONFINEMENT TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
