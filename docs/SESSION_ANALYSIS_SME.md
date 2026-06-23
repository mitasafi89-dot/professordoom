# Session Analysis: the SME-Sustainability Manuscript Run

A behavioural autopsy of one long ProfessorDoom session (the *Drivers of
Sustainability Management in SMEs* systematic-review + bibliometric manuscript),
read jointly as an **LLM-behaviour** problem and a **UI/protocol** problem, with
the concrete fixes shipped in this commit.

The raw transcript is the source; every claim below maps to something that
actually reached the user on screen.

---

## 1. What the user actually experienced (the symptoms)

Reading the transcript top to bottom, four things dominate the screen:

1. **~25 manual "continue" presses.** Almost every assistant turn is followed by
   the user typing `continue`. One human message of real intent ("write the
   manuscript, follow the contract") turned into two dozen mechanical nudges.
2. **A wall of "(no content)" turns.** Many assistant turns rendered as literally
   `(no content)` — a dead bubble with nothing in it.
3. **Tool steps frozen at `pending`.** Numerous `sandbox_python` / `sandbox_file`
   chips show status `pending` and never flip to `completed`, even after the work
   plainly happened.
4. **No way to get the deliverables.** The user explicitly asks: *"output the
   files here so I can download preview them."* The manuscript DOCX, the six
   figures, the PRISMA diagram, the reference list — none of them appeared as
   downloadable file cards.

And one tell-tale LLM pathology threaded through it:

5. **The same sentence, eight times.** Across eight separate turns the agent says
   a near-verbatim variant of *"Now I'm writing out the manuscript in markdown
   format as the main deliverable."* — without the file ever materialising in
   between. It narrated the work instead of doing it, then ended the turn.

---

## 2. Root causes — separating LLM behaviour from UI behaviour

### 2a. LLM behaviour

- **Re-announcement stall (the headline failure).** The model repeatedly ended a
  turn after *describing* its next step ("now I'm writing the manuscript…")
  rather than executing it. Each `continue` restarted the same intention, so the
  loop produced eight identical announcements and zero new artifacts. This is the
  same family of failure the contract-redesign docs diagnose as **completion
  narration** and **status fabrication**: saying a thing *feels* like doing it.
- **Premature turn endings.** Many turns ended after a single reasoning block,
  before the tool call resolved or any text was produced — which is exactly why
  the thread is littered with `(no content)` turns and `pending` chips.
- **Deliverables never exported.** The agent wrote `manuscript.md`, the DOCX, and
  the figures *inside the sandbox*, but never exported them as artifacts. From the
  UI's point of view those files do not exist — there is no `file` part to render.
  When asked to "output the files," it checked existence and still didn't export.
- **A self-caught path bug.** Files were written to `/home/user/` via
  `sandbox_file` but the Python CWD was the interaction dir, so artifacts were
  scattered. The agent noticed and standardised on absolute paths — fine, but it
  is symptomatic of working without a fixed deliverable location.

### 2b. UI / protocol behaviour

- **Auto-continue existed but was OFF by default.** Phase 6 shipped a working
  auto-continue loop (`tests/test_autocontinue.js` proves it), yet it is opt-in
  and was not engaged in this session — so the human became the loop. The single
  most valuable affordance for long contract work was dark.
- **`(no content)` rendered as a dead end.** `renderAssistantParts()` fell back
  to `render('(no content)')` for any turn with no answer/tool/file, making a
  recoverable "nothing this turn" look like a broken, terminal message.
- **`pending` chips were never reconciled.** The authoritative re-render on `done`
  copied `toolCallState` verbatim. Gumloop often doesn't echo a terminal state on
  the final REST parts, so a tool that *did* run is shown frozen at `pending`
  forever — a false status the user can't help but read as "stuck".
- **No stall detection.** Even with auto-continue on, nothing watched for "N
  turns, no progress." The eight-announcement loop would have run straight into
  the safety cap, wasting turns and credits.
- **File handoff was render-only.** The file card + `/api/file` proxy + preview
  panel are all well built — but they only fire when the agent emits a `file`
  part. Nothing nudged the agent to actually export, so the polished file UI never
  got anything to show.

The unifying theme: **the agent fragments work across many empty turns and
narrates instead of executing, and the UI was a faithful, passive mirror of that
— it dutifully showed the stalls, the blanks, and the frozen chips instead of
correcting or guarding against them.**

---

## 3. Fixes shipped in this commit

### Client (`public/app.js`, `public/styles.css`)

1. **Auto-continue ON by default.** `AUTO_CONTINUE` now defaults on unless the
   user explicitly set it to `0`. Long, multi-phase contract work drives itself;
   the ~25 manual `continue` presses disappear. The safety cap (`AUTO_CAP`, 25)
   and Stop button are unchanged.
2. **Stall guard.** A new `STALL_CAP` (default 3) breaks the auto-continue loop
   when consecutive turns produce no new output — the exact eight-announcement
   loop now stops after three with an honest, actionable note instead of spinning
   to the cap. `runTurn` now reports `outcome.empty` (no real text, tool, or file)
   computed from the authoritative `done` parts.
3. **`pending` chips reconciled.** On the authoritative re-render, any tool state
   that is empty/`pending`/`running`/`in_progress`/`started` is normalised to a
   neutral `done`. Finished turns no longer show false "stuck" spinners.
4. **`(no content)` replaced with an honest muted note.** Blank turns render as a
   quiet *"No visible output this turn — continuing automatically…"* line, not a
   dead bubble.

### Server (`server/server.js`)

5. **Hardened AUTONOMOUS-MODE directive.** The injected directive now explicitly
   forbids the observed pathologies: *never end a turn that made no concrete
   progress; if you are about to write something, write it this turn; never repeat
   the same "next I will…" sentence across turns.* And it makes deliverable export
   mandatory: *any file the user must see MUST be exported via `sandbox_download`;
   a file that exists only in the sandbox has not been delivered; confirm all
   deliverables are exported before emitting `⟦TASK_COMPLETE⟧`.* The directive
   still begins with `[AUTONOMOUS MODE]` and preserves the completion/pending
   protocol the client detects.

All changes are verified green by `tests/test_autocontinue.js` (server directive
injection, `complete`/`pending` detection, and the full no-typing browser loop).

---

## 4. What this does NOT fix (honest limits)

- The captcha wall is still per-message and unavoidable; auto-continue mints fresh
  invisible tokens but cannot remove the requirement.
- The directive *strongly discourages* re-announcement stalls but cannot force a
  given model not to narrate; the **stall guard** is the hard backstop, capping the
  damage at three empty turns rather than 25.
- Export discipline is now instructed and gated on the completion token, but a
  model that ignores the instruction will still need the user to ask once; the
  guard + note make that state visible instead of silent.
