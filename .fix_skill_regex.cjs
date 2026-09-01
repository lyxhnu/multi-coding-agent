// One-off repair: the editing tool expanded the `\n` escapes inside parseSkillBlock's regex literal
// into real newlines, which breaks the literal across lines. Rebuild it as a single line.
const fs = require("node:fs");

const file = "packages/coding-agent/src/core/agent-session.ts";
let src = fs.readFileSync(file, "utf8");

const broken = /const match = text\.match\(\/\^<skill[\s\S]*?\?\$\/\);/;
if (!broken.test(src)) {
  console.error("pattern not found — nothing to repair");
  process.exit(1);
}

// Built via char codes so no escape in this file can be mangled the same way.
const BS = String.fromCharCode(92); // backslash
const n = BS + "n";
const fixed =
  'const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">' +
  n +
  "([" + BS + "s" + BS + "S]*?)" +
  n +
  "<" + BS + "/skill>(?:" +
  n + n +
  "([" + BS + "s" + BS + "S]+))?$/);";

src = src.replace(broken, fixed);
fs.writeFileSync(file, src, "utf8");
console.log("repaired:");
console.log(fixed);
