"use strict";

/**
 * Live-progress UX unit tests.
 *
 * These guard the client-side fixes for the "I can't tell what's happening"
 * report: the status ticker must use the agent's human caption (not the raw
 * tool name), the elapsed counter must format sensibly, and the auto-continue-
 * OFF "paused mid-task" hint must fire on a parked plan but NOT on a normal
 * finished answer.
 *
 * The three functions under test are PURE, so we extract their real source from
 * public/app.js and evaluate it in a vm sandbox -- this tests the shipped code,
 * not a copy.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Pull a top-level `function name(...) { ... }` block out of app.js by matching
// balanced braces from the declaration.
function extract(name) {
  const start = SRC.indexOf("function " + name + "(");
  assert(start !== -1, "could not find function " + name + " in app.js");
  let i = SRC.indexOf("{", start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  [extract("liveStatusFor"), extract("fmtElapsed"), extract("looksParked"), extract("fileFromPart"), extract("liveStatusFor"), extract("applyFrame")].join("\n\n") +
    "\nthis.liveStatusFor = liveStatusFor; this.fmtElapsed = fmtElapsed; this.looksParked = looksParked; this.fileFromPart = fileFromPart; this.applyFrame = applyFrame;",
  ctx
);
const { liveStatusFor, fmtElapsed, looksParked, fileFromPart, applyFrame } = ctx;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log("  \u2713 " + label); pass++; }
  else { console.log("  \u2717 " + label); fail++; }
}

console.log("\nPART A \u2014 liveStatusFor prefers the human caption");
ok(liveStatusFor("web_search_tool", "Find real sources on sugarcane pests") ===
   "Find real sources on sugarcane pests\u2026", "caption used verbatim + ellipsis");
ok(liveStatusFor("sandbox_python", "Read full Manuscript Writing contract") ===
   "Read full Manuscript Writing contract\u2026", "caption wins over tool name");
ok(liveStatusFor("web_search_tool", "Searching the web\u2026") ===
   "Searching the web\u2026", "existing trailing ellipsis not doubled");
ok(liveStatusFor("web_search_tool", "") === "Searching the web\u2026", "no caption -> web phrase");
ok(liveStatusFor("sandbox_shell", "") === "Working in the sandbox\u2026", "sandbox phrase");
ok(liveStatusFor("sandbox_file", "") === "Reading files\u2026", "file phrase");
ok(liveStatusFor("", "") === "Working\u2026", "no name, no caption -> generic");
// caption equal to the raw tool name should NOT be shown as a 'caption'
ok(liveStatusFor("web_fetch_tool", "web_fetch_tool") === "Reading a web page\u2026",
   "caption==name falls through to phrase");

console.log("\nPART B \u2014 fmtElapsed");
ok(fmtElapsed(0) === "0s", "0ms -> 0s");
ok(fmtElapsed(8400) === "8s", "8.4s -> 8s");
ok(fmtElapsed(60000) === "1m 00s", "60s -> 1m 00s");
ok(fmtElapsed(64000) === "1m 04s", "64s zero-padded seconds");
ok(fmtElapsed(-50) === "0s", "negative clamped to 0s");

console.log("\nPART C \u2014 looksParked (auto-continue OFF nudge)");
// The exact failure from the report: a plan announced, nothing delivered.
ok(looksParked("I'll read the full contract, then ground the essay in real sources. Let me do both.") === true,
   "'Let me do both.' is parked");
ok(looksParked("Let me check the CSS for the live-status classes.") === true, "'Let me check...' is parked");
ok(looksParked("I'll now search the web for sources.") === true, "'I'll now search...' is parked");
ok(looksParked("Next, I will verify the citation.") === true, "'Next, I will...' is parked");
// Genuine finished answers must NOT be flagged.
ok(looksParked("Here are your five unread emails, summarized above.") === false, "summary answer not parked");
ok(looksParked("The essay is complete and the file has been exported.") === false, "completion answer not parked");
ok(looksParked("") === false, "empty reply not parked");
ok(looksParked("Sugarcane is a major cash crop in western Kenya.") === false, "plain statement not parked");

console.log("\nPART D \u2014 fileFromPart normalizes the Gumloop file part");
// Real (production) FLAT shape: download_url + display_filename, no nested .file.
const flat = fileFromPart({ type: "file", filename: "a/b/Essay.docx", display_filename: "Essay.docx",
  media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  download_url: "https://storage.googleapis.com/x/Essay.docx?sig=1", artifact_id: "A", version_id: "V" });
ok(flat && flat.url === "https://storage.googleapis.com/x/Essay.docx?sig=1", "flat: uses download_url");
ok(flat && flat.name === "Essay.docx", "flat: uses display_filename (basename)");
ok(flat && /wordprocessingml/.test(flat.mt), "flat: carries media_type");
// Legacy nested shape with artifact_url must still work.
const nested = fileFromPart({ type: "file", file: { filename: "out/Report.pdf", artifact_url: "https://gumloop.com/files/r.pdf", media_type: "application/pdf" } });
ok(nested && nested.url === "https://gumloop.com/files/r.pdf", "nested: falls back to artifact_url");
ok(nested && nested.name === "Report.pdf", "nested: basename from filename");
ok(fileFromPart({ type: "file", display_filename: "x.docx" }) === null, "no url -> null (nothing to download)");
ok(fileFromPart({ type: "text", text: "hi" }) === null, "non-file part -> null");

console.log("\nPART E \u2014 applyFrame routes production frames (no reasoning/tool-input leak)");
{
  const live = { steps: [], answer: "", status: "", files: [] };
  applyFrame({ type: "reasoning-start", id: "r1" }, live);
  applyFrame({ type: "reasoning-delta", id: "r1", delta: "thinking it through" }, live);
  applyFrame({ type: "reasoning-end", id: "r1" }, live);
  applyFrame({ type: "tool-input-start", id: "t1", toolName: "sandbox_python" }, live);
  applyFrame({ type: "tool-input-delta", id: "t1", delta: "import os  # raw code" }, live);
  applyFrame({ type: "tool-call", toolCallId: "t1", toolName: "sandbox_python", toolCaption: "Run code" }, live);
  applyFrame({ type: "tool-result", toolCallId: "t1", toolName: "sandbox_python" }, live);
  applyFrame({ type: "text-delta", id: "m", delta: "Here is the answer." }, live);
  ok(live.answer === "Here is the answer.", "answer holds ONLY text-delta (no reasoning/tool-input leak)");
  ok(live.steps.some((s) => s.kind === "think" && /thinking it through/.test(s.text)), "reasoning-delta routed to the thinking block");
  const tool = live.steps.find((s) => s.kind === "tool");
  ok(tool && tool.cap === "Run code", "tool-call sets the human caption on the step");
  ok(tool && tool.state === "completed", "tool-result marks the step completed");
  // a tool-result error sets the error state
  const live2 = { steps: [], answer: "", status: "", files: [] };
  applyFrame({ type: "tool-call", toolCallId: "x", toolName: "web_search", toolCaption: "Search" }, live2);
  applyFrame({ type: "tool-result", toolCallId: "x", toolName: "web_search", error: "boom" }, live2);
  ok(live2.steps[0] && live2.steps[0].state === "error", "tool-result with error -> error state");
}

console.log(`\n${fail === 0 ? "ALL TESTS PASSED" : fail + " ASSERTION(S) FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
