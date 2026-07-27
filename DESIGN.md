# OmniWork — Projects, Memory, Context & UX

**Status:** Draft for review
**Guiding principle:** Claude-quality behavior, minimum surface area. Every feature below has a line-count budget. If an implementation blows its budget, the design is wrong — simplify the design, don't grow the code.

---

## 1. Goals

1. **Context management** — sessions never silently die from an overflowing context window; long sessions compact themselves the way Claude Code does.
2. **Projects** — sessions group under the folder they belong to, with per-project settings and memory.
3. **Memory** — the agent can deliberately remember durable facts, per project and globally, and recalls them automatically.
4. **Slash commands** — a `/` command palette with autocomplete, like Claude Code.
5. **Navigation UX** — a non-technical person can tell where the agent is working and change it, without knowing what "cwd" means.
6. **Typography** — UI chrome reads like a polished product, not raw terminal output.

**Non-goals (explicitly out of scope):** vector search / embeddings for memory, multi-window, cloud sync, per-message branching/checkpoints, session export. All can layer on later; none earn their complexity today.

---

## 2. Current state (what we build on)

| Area | Today | File |
|---|---|---|
| Sessions | Parallel agents, transcript + status, persisted to one `sessions.json`, restored on boot | `electron/sessions.js` |
| Context | `messages[]` grows unbounded; persistence slices last 200 with no summarization | `electron/agent.js`, `sessions.js:44` |
| Memory | Read-only: `CLAUDE.md` / `AGENTS.md` / `.omniwork.md` / `.cursorrules` injected each turn | `agent.js:86-98` |
| Slash commands | Six hardcoded commands, no autocomplete | `renderer/app.js:309-322` |
| Folder UX | "cwd:" label in welcome box + `cwd` button in status line | `index.html:58-59`, `app.js:56` |
| Typography | Monospace for **everything**, incl. headers/subtitles/buttons | `styles.css:13` |

The `@`-mention popup (`app.js:282-286`, `.mpop` CSS) is a reusable pattern we lean on twice below.

---

## 3. Context management

### Behavior

- Track an estimated token count for `messages[]` (`chars / 4` — good enough; no tokenizer dependency).
- Each model has a context budget: read from the gateway's `/v1/models` metadata when present, else a conservative default (`100_000`), overridable in prefs.
- At **80% of budget** before a model call: auto-compact.
- **Compaction** = one summarization call through the same gateway:
  - Keep: system prompt, the **last 6 turns** verbatim (user/assistant/tool triples), any pending tool-call pairs (never orphan a `tool_call_id`).
  - Everything older → replaced by a single message:
    `{ role: "user", content: "[Conversation summary — earlier context was compacted]\n<summary>" }`
  - The summary prompt asks for: state of the task, decisions made, files touched, unresolved items.
- Manual trigger: `/compact`. Status line shows a subtle `⛁ 62%` context meter (click = compact now).
- On compaction failure (gateway error): fall back to hard truncation with a system notice — never crash the turn.

### Implementation

- **New file `electron/compactor.js` (~80 lines):** `estimateTokens(messages)`, `compact(messages, callModel)` → returns new messages array. Pure functions; trivially testable.
- **`agent.js` (~15 line delta):** call `maybeCompact()` at the top of the step loop in `send()`; emit `context` event `{ pct }` for the meter.
- **`sessions.js`:** persistence keeps its slice as a final backstop, but restore now lands on compacted (coherent) history instead of an amputated one.

**Budget: ~110 new lines.**

---

## 4. Projects

### Model

A **project** is a workspace folder plus everything that belongs to it:

```
userData/
  prefs.json
  projects/
    index.json              # [{ id, name, path, lastOpened }]
    <id>/
      project.json          # { model, approvalMode }  (overrides app defaults)
      memory/
        MEMORY.md           # index — one line per fact
        <slug>.md           # individual facts
      sessions/
        <sessionId>.json    # { title, status, transcript, messages }
```

- Project `id` = 8-char hash of the absolute path. Same folder ⇒ same project, always.
- One session file per session: saves are smaller and targeted, deleting a session is `unlink`, and a corrupt file loses one session, not all of them.
- **Migration:** on first boot, if legacy `sessions.json` exists — group its sessions by `workspace`, create a project per distinct folder, write per-session files, rename the old file to `sessions.json.bak`. ~25 lines, runs once.

### Behavior

- Creating a session inside a project defaults to the project folder.
- Picking a new folder for a session (folder chip, §6) moves it under that folder's project — creating the project on the fly. No separate "create project" ceremony; **projects are born from use**, exactly like Claude Code's `~/.claude/projects/`.
- **Auto-titles:** after a session's first `done` event, one cheap gateway call names it ("Fix login redirect") replacing "Session 3". Claude does this; it costs ~10 lines and transforms the sidebar.

### UI (rail)

Sessions list becomes grouped by project — no new panels, no tree-view widget:

```
PROJECTS                          +
▾ omniwork                        ← project row (folder name), collapsible
    ● Fix login redirect
    ● Add compaction
▸ aggie_nexus_mvp
```

Project row: name + collapse caret + session count when collapsed. That's it. Active project is wherever the active session lives.

### Implementation

- **New file `electron/projects.js` (~150 lines):** `ProjectManager` — registry load/save, `forWorkspace(path)` (find-or-create), per-project dirs, migration.
- **`sessions.js` (~40 line delta):** persistence delegates to per-session files under the owning project; `#snapshot`/`restore` shrink accordingly.
- **`main.js`/`preload.js` (~15 lines):** `project:list` IPC + list event.
- **`app.js` (~40 line delta):** grouped rail rendering (replaces current flat `renderSessions`).

**Budget: ~250 lines total, net of what the flat rendering/monolithic persistence code they replace.**

---

## 5. Memory

### Model — one `MEMORY.md` per scope

*(Amended during implementation: the original index-plus-fact-files design assumed the
agent could read fact files on demand, but `read_file` is workspace-rooted and memory
lives outside the workspace. A single capped `MEMORY.md` per scope is leaner and has
no unreachable files.)*

- **Per-project:** `projects/<id>/memory/MEMORY.md` — one bullet per fact, appended by `save_memory`.
- **Global:** `userData/memory/MEMORY.md` — same shape, for cross-project facts (user preferences, environment quirks).
- **Injection:** extend the existing `loadProjectMemory()` in `agent.js` — after workspace files, append global `MEMORY.md` then project `MEMORY.md`, capped (8 KB combined). Index lines are cheap; the agent reads a full fact file only when relevant (it has `read_file`).
- **Writing:** one new tool in `tools.js`:

```
save_memory({ scope: "project" | "global", title, content })
```

Writes `<slug>.md`, appends the index line. The system prompt gains two sentences telling the agent when to use it (durable preferences, hard-won fixes, project conventions — not session trivia).

- **User control:** `/memory` opens the memory folder in Finder — plain markdown files the user can read, edit, delete. No custom memory-browser UI. This is the single biggest lean-win in the whole doc: the filesystem *is* the UI.

### Deferred (design here, build later)

Auto-capture — on session `done`, a background call asks "anything durable worth saving?". Deliberately **phase 5**: get manual memory trusted first; auto-capture tunes signal-to-noise on top of a working system.

### Implementation

- **New file `electron/memory.js` (~90 lines):** read/inject helpers, slug + index append, shared by both scopes.
- **`tools.js` (~25 lines):** `save_memory` schema + executor.
- **`agent.js` (~10 line delta):** injection + prompt addition.

**Budget: ~125 lines.**

---

## 6. Folder navigation UX (kill "cwd")

The word "cwd" never appears in the UI again. The concept becomes **"folder"** — the folder the agent works in.

1. **Status line (right side):** replace `cwd-mini` + `cwd` button with one **folder chip**: `📁 omniwork ▾`. Click opens a small menu (reuses `.mpop` styling):
   - **Change folder…** → native macOS picker (existing `pickWorkspace`)
   - **Recent folders** (last 8, from the projects registry — free, we already track them)
   - **Reveal in Finder**
2. **Welcome box:** `cwd: /Users/zachary/omniwork change` becomes
   `Working in 📁 omniwork  ~/omniwork  [Change folder]` — folder name prominent, full path dimmed.
3. **New-session flow:** a fresh session on an empty state opens the folder menu first — the one moment a non-technical user must make a choice, so we surface it instead of defaulting to `~` silently (today's behavior, `sessions.js:132`).
4. `/cwd` survives as a hidden alias of `/folder` (muscle memory), but help text only shows `/folder`.

**Budget: ~70 lines renderer, 0 main-process (all existing IPC).**

---

## 7. Slash commands

### Behavior — match Claude Code's feel

- Typing `/` at the **start of the input** opens a command palette (same `.mpop` component as `@`-mentions): fuzzy filter as you type, `↑/↓` navigate, `Tab`/`Enter` complete, `Esc` dismiss.
- Each row: `/name  <args hint>  — description`.

### Design

One registry in `app.js` replaces the hardcoded `switch`:

```js
const COMMANDS = [
  { name: "help",    desc: "Show all commands",              run: ... },
  { name: "clear",   desc: "Start a fresh session",          run: ... },
  { name: "new",     desc: "New session in this project",    run: ... },
  { name: "compact", desc: "Summarize older context",        run: ... },
  { name: "memory",  desc: "Open this project's memory",     run: ... },
  { name: "folder",  desc: "Change working folder",          run: ..., alias: "cwd" },
  { name: "model",   args: "<name>", desc: "Switch model",   run: ... },
  { name: "undo",    desc: "Undo last turn's file changes",  run: ... },
  { name: "approve", args: "ask|auto", desc: "Approval mode", run: ... },
];
```

Recipes register into the same palette (`/recipe:tests`, `/recipe:bughunt`, …) — generated from the existing `RECIPES` array, zero duplication, and the palette becomes the discovery surface for everything the app can do.

The palette generalizes the existing mention-popup logic (`showPop`/`moveSel`/`pick`) into one function parameterized by item source — a refactor that *removes* duplicated popup code even as it adds the feature.

**Budget: ~80 lines net.**

---

## 8. Typography & visual polish

### Root cause of the "word spacing" problem

`styles.css:13` sets **monospace for the entire app**. In a monospace face every space is a full character cell, so headers and subtitles ("Add a connection", "One-click agent tasks…") get gappy, uneven-looking word spacing. `.rail-head`'s `letter-spacing: .08em` on top of mono caps (`styles.css:32`) makes the section labels airier still.

### Fix — two-font system (the standard terminal-app pattern; it's what Claude Code's desktop chrome does)

```css
--sans: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
--mono: (unchanged);
```

- **Sans** for chrome: rail (brand, section heads, session/connection rows), modal titles/subtitles/labels/buttons, status line labels, welcome-box prose, approval prompt question, recipe/gallery cards.
- **Mono** stays for content: transcript text, tool output, diffs, code, the input box, paths, the folder chip. Mono *is* the product's voice for agent output — we keep it exactly there.

### Specific corrections

| Issue | Fix |
|---|---|
| Body font cascades mono into all chrome (`styles.css:13`) | `body { font-family: var(--sans) }`; terminal content classes opt into `--mono` |
| `.rail-head` caps tracking too wide in mono | Sans + `letter-spacing: .06em`, `font-weight: 600` |
| Welcome copy is insider jargon ("free models via OmniRoute · MCP connections") | Rewrite: "Free AI models built in · add tools anytime · run tasks in parallel" |
| Empty `.wline` used as spacer (`app.js:54`) | Margins, not empty elements |
| `.modal-sub`, `.gc-desc` line-height cramped at 11–11.5px | Sans, `line-height: 1.5`, min size 11.5px |
| Emoji-in-mono buttons (`🛡 auto`, `⚡ recipes`) baseline-wobble | Sans on those buttons resolves it |

A11y minimum while we're in there: `:focus-visible` outlines on interactive elements (currently none) — a few lines, large payoff.

**Budget: ~60 changed CSS lines, ~10 HTML/JS copy edits.**

---

## 9. Architecture summary

```
electron/
  compactor.js   NEW  ~80    token estimate + compaction (pure functions)
  projects.js    NEW  ~150   ProjectManager: registry, dirs, migration
  memory.js      NEW  ~90    memory read/inject/write (project + global)
  agent.js       Δ    ~25    compaction hook, memory injection, context event
  sessions.js    Δ    ~40    per-project/per-session persistence
  tools.js       Δ    ~25    save_memory tool
  main.js        Δ    ~15    project:list IPC
  preload.js     Δ    ~5
renderer/
  app.js         Δ    ~190   grouped rail, folder chip+menu, command palette, meter
  index.html     Δ    ~15
  styles.css     Δ    ~60
```

≈ **700 lines total** against the current ~2,500 — proportionate. New IPC surface: **one** channel (`project:list`); everything else rides existing channels.

## 10. Phasing

| Phase | Scope | Why this order |
|---|---|---|
| **1** | Typography + folder chip/menu + command palette | Renderer-only, zero data-model risk, immediately visible quality jump |
| **2** | Context compaction | Highest-severity gap; isolated in `compactor.js` + one hook |
| **3** | Projects: storage refactor, migration, grouped rail, auto-titles | Structural change; memory needs project dirs to exist |
| **4** | Memory: injection + `save_memory` + `/memory` | Builds on 3 |
| **5** | Polish: auto-capture memory, context meter refinements | Optional, after 1–4 prove out |

Each phase ships independently and leaves the app fully working.

## 11. Testing

Follow the existing `test/*.js` node-script pattern:

- `test/compact.js` — synthetic long conversation → compaction preserves system msg + recent turns + tool-call pairing; token estimate drops below threshold.
- `test/projects.js` — legacy `sessions.json` migration; find-or-create by path; per-session file round-trip.
- `test/memory.js` — save → index line appended → injection contains it; 8 KB cap respected.
- Extend `test/persist.js` for the per-project layout.

---

## 12. Skills (added during implementation)

User-installable instruction packs, **format-compatible with Claude Code's `SKILL.md`**
(frontmatter `name`/`description` + markdown body), so existing skill repos install as-is.

- **Layout:** global `userData/skills/<name>/SKILL.md` (every project) and
  `<workspace>/.omniwork/skills/<name>/` (travels with the repo; shadows global on name clash).
- **Runtime:** the system prompt lists only name + description per skill; the agent loads a
  body on demand via the `use_skill` tool (progressive disclosure — a dozen skills cost a few
  hundred prompt tokens). `save_skill` lets the agent codify a workflow the user wants kept.
- **Install:** `/skill:install <git-url | owner/repo | folder>` clones/scans (depth-limited)
  for `SKILL.md` directories and copies them — **nothing from the repo is executed**.
- **Create:** `/skill:new <name>` scaffolds a template and reveals it in Finder; `/skills`
  opens the folder. Plain files are the management UI, like memory.
- **Discovery:** every installed skill appears in the `/` palette as `/<name> <task>`
  (built-ins win name collisions), which sends the agent an instruction to load that skill.

Module: `electron/skills.js` (~150 lines) + `test/skills.js`.

## 13. Open questions

1. Auto-compact summarization model: pinned cheap model vs. session's current model? (Proposal: session model — zero config, one less concept.)
2. Should the context meter live in the status line always, or appear only past 50%? (Proposal: appear at 50% — quiet until relevant.)
3. Global memory opt-out toggle in prefs, or ship always-on and see? (Proposal: always-on; it's plain files the user can see and delete.)
