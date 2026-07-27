// Unit test: approval decisions across the four modes (auto/ask/edits/plan).
const { approvalDecision: d } = require("../electron/agent");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

// auto: everything runs
check("auto allows commands", d("auto", "run_command") === "allow");
check("auto allows edits", d("auto", "edit_file") === "allow");

// ask: commands, edits, installs, and MCP tools all prompt
check("ask gates commands", d("ask", "run_command") === "ask");
check("ask gates writes", d("ask", "write_file") === "ask");
check("ask gates skill installs", d("ask", "install_skills") === "ask");
check("ask gates MCP tools", d("ask", "mcp__github__create_issue", true) === "ask");
check("ask allows reads", d("ask", "read_file") === "allow");
check("ask allows browsing", d("ask", "browse_page") === "allow");

// edits: file changes auto-accept, commands still prompt
check("edits allows writes", d("edits", "write_file") === "allow");
check("edits allows edits", d("edits", "edit_file") === "allow");
check("edits gates commands", d("edits", "run_command") === "ask");
check("edits gates installs", d("edits", "install_skills") === "ask");

// plan: file changes hard-blocked, commands prompt, reads free
check("plan blocks writes", d("plan", "write_file") === "block");
check("plan blocks edits", d("plan", "edit_file") === "block");
check("plan blocks installs", d("plan", "install_skills") === "block");
check("plan gates commands", d("plan", "run_command") === "ask");
check("plan allows reads", d("plan", "read_file") === "allow");
check("plan allows search", d("plan", "web_search") === "allow");

// unknown mode falls back to auto
check("unknown mode → allow", d("bogus", "run_command") === "allow");

console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ MODES TEST PASSED");
process.exit(fails ? 1 : 0);
