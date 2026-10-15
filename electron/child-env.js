"use strict";
// Environments for the processes OmniWork starts. Neither a model-chosen
// command nor the gateway inherits the user's shell environment wholesale:
// that is where tokens live (GITHUB_TOKEN, AWS_*, provider keys, database
// URLs), and for the gateway, settings like CORS_ALLOW_ALL that it must not
// pick up by accident. Each gets an explicit allowlist instead.

// What any process needs to run and reach the network: PATH (repaired from
// the login shell by shell-path.js), home and temp dirs, locale, proxies and
// CA bundles, and the variables Windows needs to start a process at all.
const BASE = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "TZ", "LANG", "LANGUAGE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "HOMEDRIVE", "HOMEPATH",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

// Commands also get the terminal and toolchain locations — paths, not
// credentials — so builds behave as they do in the user's Terminal.
const COMMAND = [
  ...BASE, "SHELL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "NVM_DIR", "PYENV_ROOT", "VIRTUAL_ENV", "CONDA_PREFIX",
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT", "HOMEBREW_PREFIX", "BUN_INSTALL", "PNPM_HOME", "VOLTA_HOME",
];

// Settings that would open the gateway to other origins. Never forwarded, even
// when the full environment is.
const GATEWAY_NEVER = new Set(["CORS_ALLOW_ALL", "CORS_ORIGIN", "CORS_ALLOWED_ORIGINS"]);

const inherits = (v) => /^inherit$/i.test(String(v || ""));
const listOf = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

// Windows names are case-insensitive (Path, SystemRoot); elsewhere exact.
function pick(names, base) {
  const norm = process.platform === "win32" ? (k) => k.toUpperCase() : (k) => k;
  const keep = new Set(names.map(norm));
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v != null && (keep.has(norm(k)) || /^LC_/.test(k))) env[k] = v;
  return env;
}

// OMNIWORK_COMMAND_ENV_PASSTHROUGH=NAME,NAME adds variables;
// OMNIWORK_COMMAND_ENV=inherit restores the full environment for one release.
function commandEnv(workspace, base = process.env) {
  if (inherits(base.OMNIWORK_COMMAND_ENV)) return { ...base };
  const env = pick([...COMMAND, ...listOf(base.OMNIWORK_COMMAND_ENV_PASSTHROUGH)], base);
  if (workspace) env.PWD = workspace;
  return env;
}

// The gateway's own settings are layered on top by the caller.
// OMNIWORK_GATEWAY_ENV_PASSTHROUGH=NAME,NAME adds variables (e.g. an
// OmniRoute setting); OMNIWORK_GATEWAY_ENV=inherit restores the full
// environment for one release, minus the cross-origin settings.
function gatewayEnv(base = process.env) {
  const env = inherits(base.OMNIWORK_GATEWAY_ENV) ? { ...base } : pick([...BASE, ...listOf(base.OMNIWORK_GATEWAY_ENV_PASSTHROUGH)], base);
  for (const k of Object.keys(env)) if (GATEWAY_NEVER.has(k.toUpperCase())) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE; // never let Electron's node-mode flag leak into the child
  return env;
}

module.exports = { commandEnv, gatewayEnv, inheritsCommandEnv: (base = process.env) => inherits(base.OMNIWORK_COMMAND_ENV) };
