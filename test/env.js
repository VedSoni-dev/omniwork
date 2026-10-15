"use strict";
// What child processes inherit. The regression: run_command spawned the
// user's login shell with process.env, so every secret in the environment
// (GITHUB_TOKEN, AWS_*, DATABASE_URL, provider keys) reached model-chosen
// commands, and the login shell re-sourced the profile on top. The gateway
// got the same process.env, CORS_ALLOW_ALL included.
//
// Run: node test/env.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { executeToolResult } = require("../electron/tools");
const { commandEnv, gatewayEnv } = require("../electron/child-env");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const SECRETS = {
  GITHUB_TOKEN: "ghp_test_secret_value_1",
  AWS_SECRET_ACCESS_KEY: "aws_test_secret_value_2",
  DATABASE_URL: "postgres://user:test_secret_value_3@db/prod",
  OPENROUTER_API_KEY: "sk-or-test_secret_value_4",
};

(async () => {
  if (process.platform === "win32") { console.log("- POSIX shell checks; skipping on Windows"); process.exit(0); }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-env-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-env-home-"));
  // Profile files a login shell would source; a plain -c shell does not.
  for (const f of [".zprofile", ".zlogin", ".bash_profile", ".profile", ".bash_login"]) fs.writeFileSync(path.join(home, f), "export FROM_PROFILE=profile_test_secret_value_5\n");
  Object.assign(process.env, SECRETS, { HOME: home, LC_ALL: "C", OMNIWORK_TEST_VISIBLE: "nope" });
  delete process.env.OMNIWORK_COMMAND_ENV;
  delete process.env.OMNIWORK_COMMAND_ENV_PASSTHROUGH;

  const run = async (command) => (await executeToolResult("run_command", { command }, { workspace })).text;

  const plain = await run("env; echo FROM_PROFILE=$FROM_PROFILE");
  const leaked = Object.entries(SECRETS).filter(([, v]) => plain.includes(v)).map(([k]) => k);
  check("no secret from the environment reaches a command", leaked.length === 0);
  check("…nor an unlisted variable", !plain.includes("OMNIWORK_TEST_VISIBLE"));
  check("the profile is not sourced (no login shell)", !plain.includes("profile_test_secret_value_5"));
  check("commands still get PATH and HOME", /(^|\n)PATH=/.test(plain) && plain.includes(`HOME=${home}`));
  check("…the locale", plain.includes("LC_ALL=C"));
  check("…and run in the workspace", (await run("pwd -P")).startsWith(fs.realpathSync(workspace)));
  check("toolchains on PATH still resolve", /\[exit code 0\]/.test(await run("command -v node && node -e \"process.exit(0)\"")));

  process.env.OMNIWORK_COMMAND_ENV_PASSTHROUGH = "GITHUB_TOKEN, DATABASE_URL";
  const passed = await run("env");
  check("OMNIWORK_COMMAND_ENV_PASSTHROUGH adds named variables", passed.includes(SECRETS.GITHUB_TOKEN) && passed.includes(SECRETS.DATABASE_URL));
  check("…and only those", !passed.includes(SECRETS.AWS_SECRET_ACCESS_KEY));
  delete process.env.OMNIWORK_COMMAND_ENV_PASSTHROUGH;

  process.env.OMNIWORK_COMMAND_ENV = "inherit";
  const inherited = await run("env");
  check("OMNIWORK_COMMAND_ENV=inherit restores the full environment", Object.values(SECRETS).every((v) => inherited.includes(v)));
  delete process.env.OMNIWORK_COMMAND_ENV;

  // Pure: Windows names are matched case-insensitively.
  const winish = commandEnv("/w", { Path: "C:\\bin", SystemRoot: "C:\\Windows", GITHUB_TOKEN: "x" });
  check("commandEnv keeps listed names and drops the rest", process.platform !== "win32" ? !("GITHUB_TOKEN" in winish) : winish.Path && winish.SystemRoot && !winish.GITHUB_TOKEN);

  // ── the gateway ──
  const gwBase = { ...SECRETS, PATH: "/usr/bin", HOME: home, CORS_ALLOW_ALL: "true", CORS_ORIGIN: "*", ELECTRON_RUN_AS_NODE: "1" };
  const gwEnv = gatewayEnv(gwBase);
  check("the gateway gets PATH and HOME", gwEnv.PATH === "/usr/bin" && gwEnv.HOME === home);
  check("…no secrets", !Object.keys(SECRETS).some((k) => k in gwEnv));
  check("…and no cross-origin settings", !("CORS_ALLOW_ALL" in gwEnv) && !("CORS_ORIGIN" in gwEnv) && !("ELECTRON_RUN_AS_NODE" in gwEnv));
  check("OMNIWORK_GATEWAY_ENV_PASSTHROUGH adds named variables", gatewayEnv({ ...gwBase, OMNIWORK_GATEWAY_ENV_PASSTHROUGH: "OPENROUTER_API_KEY" }).OPENROUTER_API_KEY === SECRETS.OPENROUTER_API_KEY);
  const gwInherit = gatewayEnv({ ...gwBase, OMNIWORK_GATEWAY_ENV: "inherit" });
  check("OMNIWORK_GATEWAY_ENV=inherit passes everything but the cross-origin settings", gwInherit.GITHUB_TOKEN === SECRETS.GITHUB_TOKEN && !("CORS_ALLOW_ALL" in gwInherit));

  // What a real start() hands the process: a stand-in server dumps its env.
  const net = require("node:net");
  process.env.OMNIWORK_GATEWAY_PORT = String(await new Promise((r) => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const { port } = sv.address(); sv.close(() => r(port)); }); }));
  process.env.OMNIWORK_NODE = process.execPath;
  process.env.CORS_ALLOW_ALL = "true";
  const { Gateway } = require("../electron/sidecar");
  const omniDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-env-omni-"));
  fs.mkdirSync(path.join(omniDir, "dist"));
  fs.writeFileSync(path.join(omniDir, "dist", "server.js"), `
require("fs").writeFileSync(require("path").join(__dirname, "env.json"), JSON.stringify(process.env));
require("http").createServer((q, r) => { r.writeHead(200); r.end('{"data":[]}'); }).listen(Number(process.env.PORT), process.env.HOSTNAME);
`);
  const gwData = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-env-gw-"));
  const gw = new Gateway({ dataDir: gwData, omniDir, healthTimeoutMs: 10_000, onStatus: () => {} });
  await gw.start();
  const seen = JSON.parse(fs.readFileSync(path.join(omniDir, "dist", "env.json"), "utf8"));
  gw.stop();
  check("the spawned gateway sees none of the shell's secrets", !Object.values(SECRETS).some((v) => JSON.stringify(seen).includes(v)));
  check("…nor CORS_ALLOW_ALL from the shell", !("CORS_ALLOW_ALL" in seen));
  check("…but gets its own settings", seen.PORT === process.env.OMNIWORK_GATEWAY_PORT && seen.HOSTNAME === "127.0.0.1" && seen.DATA_DIR === path.join(gwData, "omniroute"));
  delete process.env.CORS_ALLOW_ALL;
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(omniDir, { recursive: true, force: true });
  fs.rmSync(gwData, { recursive: true, force: true });

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ ENVIRONMENT TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
