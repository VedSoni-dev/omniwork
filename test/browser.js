// Unit test: the pure parts of built-in browsing — DuckDuckGo result parsing
// and URL validation. Live page rendering is exercised in the running app.
const { parseDdg, assertHttp } = require("../electron/browser");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const fixture = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fanthropics%2Fskills&rut=abc">anthropics/<b>skills</b>: Public skills</a>
  <a class="result__snippet" href="#">A collection of <b>SKILL.md</b> packs for agents.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/direct">Direct result</a>
  <a class="result__snippet" href="#">Plain link, no redirect.</a>
</div>
<div class="result">
  <a class="result__a" href="javascript:alert(1)">Bad scheme</a>
</div>`;

const results = parseDdg(fixture);
check("parses redirect-wrapped result", results[0].url === "https://github.com/anthropics/skills");
check("strips markup from titles", results[0].title === "anthropics/skills: Public skills");
check("captures snippet text", results[0].snippet.includes("SKILL.md packs"));
check("parses direct links too", results[1].url === "https://example.com/direct");
check("drops non-http results", results.length === 2);
check("respects limit", parseDdg(fixture, 1).length === 1);

check("assertHttp accepts https", assertHttp("https://example.com/x") === "https://example.com/x");
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check("assertHttp rejects file://", throws(() => assertHttp("file:///etc/passwd")));
check("assertHttp rejects garbage", throws(() => assertHttp("not a url")));

console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ BROWSER TEST PASSED");
process.exit(fails ? 1 : 0);
