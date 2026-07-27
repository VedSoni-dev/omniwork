"use strict";
// Built-in browsing: OmniWork ships Chromium (it's an Electron app), so every
// install can browse the real web with zero extra downloads. A single hidden
// window renders pages (JavaScript included) and returns readable text +
// links; search goes through DuckDuckGo's HTML endpoint — no API key.
//
// Pages are untrusted input: extraction is capped, only http(s) loads, and the
// window uses an ephemeral session partition so browsing state never touches
// the app.

const MAX_TEXT = 12_000;
const MAX_LINKS = 25;
const LOAD_TIMEOUT = 20_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web. Returns result titles, URLs, and snippets. Follow up with browse_page on promising results.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

const BROWSE_TOOL = {
  type: "function",
  function: {
    name: "browse_page",
    description: "Open a URL in a real browser (renders JavaScript) and return the page's readable text plus its links. Use for exploring sites, docs, or pages web_fetch can't render. The window keeps state between calls, so you can follow links across calls.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
};

// Runs in page context; must return JSON-serializable data only.
const EXTRACT_JS = `(() => {
  const abs = (h) => { try { return new URL(h, location.href).href; } catch { return null; } };
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = abs(a.getAttribute("href"));
    const text = (a.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    if (href && text && href.startsWith("http")) links.push(text + " -> " + href);
    if (links.length >= ${MAX_LINKS}) break;
  }
  return {
    title: document.title || "",
    url: location.href,
    text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ${MAX_TEXT}),
    links,
  };
})()`;

// Pure: parse DuckDuckGo's HTML results page. Exported for tests.
function parseDdg(html, limit = 8) {
  const out = [];
  const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const links = [...String(html).matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  for (let i = 0; i < links.length && out.length < limit; i++) {
    let url = links[i][1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
    if (!/^https?:\/\//.test(url)) continue;
    // The snippet lives between this result link and the next one.
    const block = html.slice(links[i].index + links[i][0].length, links[i + 1] ? links[i + 1].index : undefined);
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: strip(links[i][2]), url, snippet: strip(sn && sn[1]).slice(0, 200) });
  }
  return out;
}

function assertHttp(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("invalid URL: " + url); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs can be browsed");
  return u.href;
}

class BrowserManager {
  constructor() { this.win = null; }

  #ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { BrowserWindow } = require("electron"); // lazy: pure helpers stay node-testable
    this.win = new BrowserWindow({
      show: false, width: 1200, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "browse" },
    });
    this.win.webContents.setAudioMuted(true);
    this.win.webContents.userAgent = UA;
    // Keep the hidden window hidden — some pages try window.open/popups.
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return this.win;
  }

  async open(url) {
    const href = assertHttp(url);
    const win = this.#ensure();
    await Promise.race([
      win.loadURL(href).catch((e) => { if (!String(e).includes("ERR_ABORTED")) throw e; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("page load timed out")), LOAD_TIMEOUT)),
    ]);
    await new Promise((r) => setTimeout(r, 900)); // let SPAs render
    const page = await win.webContents.executeJavaScript(EXTRACT_JS, true);
    return `# ${page.title}\n${page.url}\n\n${page.text}\n\n## Links on this page\n${page.links.join("\n")}`;
  }

  async search(query) {
    const q = String(query || "").trim();
    if (!q) return "Empty search query.";
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
    });
    const results = parseDdg(await res.text());
    if (!results.length) return `No results for "${q}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
  }

  dispose() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

module.exports = { BrowserManager, WEB_SEARCH_TOOL, BROWSE_TOOL, parseDdg, assertHttp };
