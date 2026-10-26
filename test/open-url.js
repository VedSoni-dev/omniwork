"use strict";
// open_url never goes through a shell. The regression: on Windows the plain-Node
// servers (ACP, MCP, jobs) ran `start <url>` under cmd.exe, which doesn't
// escape arguments, so `https://x.test/?a=1&calc.exe` opened the page and then
// ran calc.exe — a command behind an approval that read "Open …".
//
// Run: node test/open-url.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openerCommand, executeToolResult } = require("../electron/tools");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

(async () => {
  const hostile = "https://x.test/?a=1&calc.exe|whoami^ %PATH%";
  const win = openerCommand(hostile, "win32");
  check("Windows opens through rundll32, not cmd.exe's start", win.cmd === "rundll32.exe" && win.args[0] === "url.dll,FileProtocolHandler");
  check("…with the whole URL as one argument, metacharacters and all", win.args.length === 2 && win.args[1] === win.href && /&calc\.exe\|whoami\^/.test(win.href));
  check("…and spaces and quotes percent-encoded, so nothing can split it", !/[ "]/.test(openerCommand('https://x.test/a b"c', "win32").href));
  check("macOS uses open, Linux xdg-open, each with the URL alone", openerCommand(hostile, "darwin").cmd === "open" && openerCommand(hostile, "linux").cmd === "xdg-open" && openerCommand(hostile, "linux").args.length === 1);
  check("only http(s) URLs are opened", throws(() => openerCommand("file:///etc/passwd")) && throws(() => openerCommand("javascript:alert(1)")) && throws(() => openerCommand("calc.exe")));

  if (process.platform !== "win32") {
    // The real spawn path: a stand-in opener on PATH records the argv it got.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-open-"));
    const out = path.join(dir, "argv.json");
    const opener = path.join(dir, process.platform === "darwin" ? "open" : "xdg-open");
    fs.writeFileSync(opener, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(out)} "$@"\n`);
    fs.chmodSync(opener, 0o755);
    const PATH = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${PATH}`;
    const res = await executeToolResult("open_url", { url: "https://x.test/?a=1&touch=pwned" }, { workspace: dir });
    process.env.PATH = PATH;
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    const argv = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
    check("open_url hands the opener exactly the URL", res.ok && JSON.stringify(argv) === JSON.stringify(["https://x.test/?a=1&touch=pwned"]));
    const bad = await executeToolResult("open_url", { url: "https://exa mple.com" }, { workspace: dir });
    check("an unparseable URL is an error, not a launch", !bad.ok && /^Error in open_url/.test(bad.text));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ OPEN_URL TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
