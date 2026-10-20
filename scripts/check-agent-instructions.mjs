import { access, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const required = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  "docs/developer/ai-collaboration.md",
];

const failures = [];
const contents = new Map();

for (const path of required) {
  try {
    contents.set(path, await readFile(resolve(root, path), "utf8"));
  } catch {
    failures.push(`Missing AI instruction entry point: ${path}`);
  }
}

const claude = contents.get("CLAUDE.md") ?? "";
if (!claude.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md")) {
  failures.push("CLAUDE.md must import the canonical AGENTS.md using @AGENTS.md");
}

const copilot = contents.get(".github/copilot-instructions.md") ?? "";
if (!copilot.includes("[AGENTS.md](../AGENTS.md)")) {
  failures.push(".github/copilot-instructions.md must link to ../AGENTS.md");
}

const shared = contents.get("AGENTS.md") ?? "";
if (!shared.includes("docs/README.md") || !shared.includes("npm run verify")) {
  failures.push("AGENTS.md must link to the docs index and provide verification guidance");
}

for (const [file, markdown] of contents) {
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].trim();
    if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;

    const target = decodeURIComponent(href.split("#", 1)[0].split("?", 1)[0]);
    if (!target) continue;

    const absolute = resolve(dirname(resolve(root, file)), target);
    if (!absolute.startsWith(root + sep)) {
      failures.push(`${file}: link escapes repository -> ${href}`);
      continue;
    }

    try {
      await access(absolute);
    } catch {
      failures.push(`${file}: broken local link -> ${href}`);
    }
  }
}

if (failures.length) {
  console.error("Agent instructions check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("AI instruction entry points and local links: ok");
}
