// Renderer test: copy-on-select + "add to chat".
// Boots the real app and drives the page through OMNIWORK_UI_TEST, then checks
// the system clipboard actually changed — the whole point of copy-on-select.
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const PROBE = 'SELECTION_PROBE_ONE\nSELECTION_PROBE_TWO';
const SENTINEL = 'CLIPBOARD_SENTINEL_UNTOUCHED';

const page = `(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const scroll = document.getElementById("scroll");
  const input = document.getElementById("input");
  const selectContents = (el) => {
    // The engine finishing its boot mid-test re-renders the transcript, which
    // detaches our probe nodes — put them back rather than racing the app.
    if (!scroll.contains(el)) scroll.appendChild(el);
    // A real mousedown in the transcript blurs the composer; synthetic events
    // don't move focus, so do it explicitly or the selection reads as "editing".
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges(); sel.addRange(range);
  };
  return (async () => {
    const blk = document.createElement("div");
    blk.className = "blk assistant";
    blk.textContent = ${JSON.stringify(PROBE)};
    scroll.appendChild(blk);

    // 1. highlight transcript text -> clipboard + floating pill
    selectContents(blk);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(150);
    const bar = document.querySelector(".selbar");
    out.pillShown = !!bar;
    out.toastShown = !!document.querySelector("#toast.show");
    if (!bar) return out;

    // 2. "Add to chat" -> visible "> " quoted lines in the prompt itself
    bar.querySelector('[data-act="add"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await wait(60);
    out.promptText = input.value;
    out.pillDismissed = !document.querySelector(".selbar");
    out.focusBackOnInput = document.activeElement === input;
    // the mirror dims those lines rather than the textarea painting them
    out.mirrorQuoteLines = document.querySelectorAll("#input-hl .q").length;
    out.mirrorText = document.getElementById("input-hl").textContent.trim();

    // 3. the keyboard shortcut quotes too
    selectContents(blk);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(60);
    out.quoteLinesAfterShortcut = input.value.split("\\n").filter((l) => l.startsWith("> ")).length;

    // 4. a long selection collapses instead of flooding the prompt
    input.value = ""; grow();
    const long = document.createElement("div");
    long.className = "blk assistant";
    long.textContent = Array.from({ length: 322 }, (_, i) => "line " + (i + 1)).join("\\n");
    scroll.appendChild(long);
    selectContents(long);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(120);
    document.querySelector('.selbar [data-act="add"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await wait(60);
    out.longQuoteCollapsed = input.value.trim();
    out.mirrorPasteTokens = document.querySelectorAll("#input-hl .pt").length;
    // the body is held aside and spliced back in on the way to the model
    out.expandsBack = expandPastes(input.value).includes("line 322");
    out.expandedLineCount = expandPastes(input.value).split("\\n").filter((l) => /^line \\d+\\s*$/.test(l)).length;
    // deleting the token drops its body — what you see is what gets sent
    input.value = "just this"; grow();
    out.droppedWhenTokenDeleted = expandPastes(input.value) === "just this";
    long.remove();
    input.value = ""; grow();

    // 4a2. Backspace touching a token removes the whole block in one keystroke
    input.value = ""; grow();
    insertPaste(Array.from({ length: 20 }, (_, i) => "atomic " + i).join("\\n"));
    const beforeDel = input.value;
    input.setSelectionRange(beforeDel.length, beforeDel.length); // caret past the trailing space
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await wait(30);
    out.backspaceClearedToken = input.value === "" && beforeDel.startsWith("[Pasted text #");
    out.backspaceDroppedBody = expandPastes(beforeDel) === beforeDel; // body no longer known
    // ...and it only eats the token, not the words around it
    input.value = ""; grow();
    input.value = "before "; input.setSelectionRange(7, 7); grow();
    insertPaste(Array.from({ length: 20 }, (_, i) => "mid " + i).join("\\n"));
    const withTail = input.value + "after";
    input.value = withTail; grow();
    const tokenEnd = withTail.indexOf("]") + 2; // token + the space we inserted
    input.setSelectionRange(tokenEnd, tokenEnd);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await wait(30);
    out.backspaceKeptSurroundingText = input.value === "before after";
    // plain Backspace elsewhere is untouched
    input.value = "plain text"; input.setSelectionRange(10, 10); grow();
    const plainEv = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    input.dispatchEvent(plainEv);
    out.plainBackspaceUntouched = !plainEv.defaultPrevented && input.value === "plain text";
    input.value = ""; grow();

    // 4b. a long *paste* into the prompt collapses the same way
    input.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", Array.from({ length: 40 }, (_, i) => "pasted " + i).join("\\n"));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(60);
    out.pasteCollapsed = input.value.trim();
    out.pasteExpandsBack = expandPastes(input.value).includes("pasted 39");
    // short pastes are left alone — the browser inserts them normally
    input.value = ""; grow();
    const dt2 = new DataTransfer();
    dt2.setData("text/plain", "short one-liner");
    const ev2 = new ClipboardEvent("paste", { clipboardData: dt2, bubbles: true, cancelable: true });
    input.dispatchEvent(ev2);
    out.shortPasteUntouched = !ev2.defaultPrevented;
    input.value = ""; grow();

    // 4c. the mirror must wrap and space text exactly like the textarea, or the
    // transparent text and the painted text drift apart as you type
    const hlEl = document.getElementById("input-hl");
    out.metrics = [
      "one line",
      "\\nleading blank line",                       // <pre> would eat this newline
      "trailing blank line\\n",
      "x".repeat(400),                               // unbreakable run -> hard wrap
      Array.from({ length: 30 }, () => "word").join(" ") + "\\nsecond\\n> quoted",
      "[Pasted text #9 +12 lines] and text after",
    ].map((v) => {
      input.value = v; grow();
      return { drift: hlEl.scrollHeight - input.scrollHeight, mirrored: hlEl.textContent === v };
    });
    out.metricsAligned = out.metrics.every((m) => Math.abs(m.drift) <= 1 && m.mirrored);
    input.value = ""; grow();

    // 5. selecting in the composer is editing, not quoting
    input.value = "editing this text, not quoting it";
    input.focus(); input.setSelectionRange(0, 12);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(80);
    out.pillSuppressedInComposer = !document.querySelector(".selbar");

    // 6. ...and so is selecting in a project-page field
    const ta = document.createElement("textarea");
    ta.value = "project instructions";
    scroll.appendChild(ta);
    ta.focus(); ta.setSelectionRange(0, 7);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(80);
    out.pillSuppressedInProjectField = !document.querySelector(".selbar");
    ta.remove();

    // 7. deselecting hides the pill
    selectContents(blk);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(80);
    out.pillReshown = !!document.querySelector(".selbar");
    window.getSelection().removeAllRanges();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(80);
    out.pillHiddenOnDeselect = !document.querySelector(".selbar");

    // 8. /copy off swaps the implicit copy for an explicit button
    out.copyCommandFound = !!allCommands().find((c) => c.name === "copy");
    handleSlash("/copy off");
    await wait(40);
    selectContents(blk);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait(80);
    const bar2 = document.querySelector(".selbar");
    out.copyButtonWhenOff = !!(bar2 && bar2.querySelector('[data-act="copy"]'));
    window.getSelection().removeAllRanges();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    handleSlash("/copy on"); // restore the default so prefs.json isn't left off
    return out;
  })();
})()`;

// Reading the OS clipboard is platform-specific; skip that assertion elsewhere.
const clip = { darwin: ['pbpaste', []], linux: ['xclip', ['-o', '-selection', 'clipboard']] }[process.platform];
function readClipboard() {
  if (!clip) return null;
  try { return require('node:child_process').execFileSync(clip[0], clip[1], { encoding: 'utf8' }); } catch { return null; }
}
function writeClipboard(text) {
  if (process.platform !== 'darwin') return false;
  try { require('node:child_process').execSync('pbcopy', { input: text }); return true; } catch { return false; }
}

// SIGTERM, never SIGKILL: main.js traps it to stop the gateway, which is
// spawned detached and would otherwise outlive us as an orphan still holding
// its port — the next launch adopts a dead engine and reports "engine error".
function shutdown(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 8000);
    child.once('exit', () => { clearTimeout(hard); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(hard); resolve(); }
  });
}

(async () => {
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ow-sel-')), 'page.js');
  fs.writeFileSync(scriptPath, page);
  const clipboardTestable = writeClipboard(SENTINEL);

  // Its own port and profile, so a test run can never collide with — or edit
  // the prefs of — a copy of the app the developer has open.
  const PORT = 20429;
  const profile = path.join(os.tmpdir(), 'omniwork-selection-test');
  const electron = require.resolve('electron/cli.js');
  const child = spawn(process.execPath, [electron, path.join(__dirname, '..'), `--user-data-dir=${profile}`], {
    env: { ...process.env, OMNIWORK_UI_TEST: scriptPath, OMNIWORK_GATEWAY_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });

  const result = await new Promise((resolve) => {
    const bail = setTimeout(() => { clearInterval(poll); resolve(null); }, 120_000);
    const poll = setInterval(() => {
      const m = buf.match(/\[ui-test\] (.+)/);
      const err = buf.match(/\[ui-test-error\] (.+)/);
      if (!m && !err) return;
      clearInterval(poll); clearTimeout(bail);
      // Let the renderer's last IPC (the /copy on prefs write) land.
      setTimeout(() => resolve(m ? JSON.parse(m[1]) : { error: err[1] }), 500);
    }, 250);
  });
  await shutdown(child);

  // Prove we cleaned up after ourselves rather than leaving a spinning orphan.
  let leaked = false;
  if (process.platform !== 'win32') {
    try { require('node:child_process').execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { stdio: 'pipe' }); leaked = true; } catch {}
  }
  if (leaked) console.log(`⚠ a gateway is still listening on ${PORT} — orphaned sidecar`);

  if (!result) { console.log('❌ FAILED — timed out waiting for the renderer'); process.exit(1); }
  console.log(JSON.stringify(result, null, 2));

  const copied = clipboardTestable ? readClipboard() : null;
  const clipboardOk = !clipboardTestable || copied === PROBE;
  if (clipboardTestable) console.log('clipboard after highlight:', JSON.stringify(copied));
  else console.log('clipboard check skipped on this platform');

  const ok =
    result.pillShown && result.toastShown &&
    result.promptText === '> SELECTION_PROBE_ONE\n> SELECTION_PROBE_TWO\n' &&
    result.mirrorQuoteLines === 2 &&
    result.mirrorText === '> SELECTION_PROBE_ONE\n> SELECTION_PROBE_TWO' &&
    result.pillDismissed && result.focusBackOnInput &&
    result.quoteLinesAfterShortcut === 4 &&
    result.longQuoteCollapsed === '[Pasted text #1 +322 lines]' &&
    result.mirrorPasteTokens === 1 &&
    result.expandsBack && result.expandedLineCount === 322 &&
    result.droppedWhenTokenDeleted &&
    /^\[Pasted text #\d+ \+40 lines\]$/.test(result.pasteCollapsed) &&
    result.pasteExpandsBack && result.shortPasteUntouched &&
    result.metricsAligned &&
    result.backspaceClearedToken && result.backspaceDroppedBody &&
    result.backspaceKeptSurroundingText && result.plainBackspaceUntouched &&
    result.pillSuppressedInComposer && result.pillSuppressedInProjectField &&
    result.pillReshown && result.pillHiddenOnDeselect &&
    result.copyCommandFound && result.copyButtonWhenOff &&
    clipboardOk && !leaked;

  console.log('\n' + (ok ? '✅ SELECTION TEST PASSED (copy-on-select + add to chat)' : '❌ FAILED'));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('crash', e); process.exit(1); });
