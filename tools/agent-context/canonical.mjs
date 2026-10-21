import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const MAX_FILE_BYTES = 256 * 1024;
const ALLOWED = new Set([".md", ".mjs", ".js", ".ts", ".json", ".yaml", ".yml"]);
const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".context", ".context-packs"]);

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function safePath(path) {
  if (typeof path !== "string" || !path || path !== path.trim() ||
      path.includes("\\") || path.includes("\0") || isAbsolute(path)) {
    throw Error("Invalid local repository path");
  }
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || SKIP.has(p) ||
        /^\.env(?:\.|$)/i.test(p) || /^(secret|secrets|credentials)$/i.test(p))) {
    throw Error("Blocked local repository path");
  }
  if (!ALLOWED.has(extname(path).toLowerCase())) throw Error("Non-text source path refused");
  return path;
}

export async function readSource(root, path) {
  safePath(path);
  const base = await realpath(root);
  const location = resolve(base, path);
  const status = await lstat(location);
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_FILE_BYTES) {
    throw Error("File is not an eligible regular text file: " + path);
  }
  const finalPath = await realpath(location);
  const rel = relative(base, finalPath);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw Error("Source escapes repository: " + path);
  }
  const text = await readFile(finalPath, "utf8");
  if (text.includes("\0")) throw Error("Binary content refused: " + path);
  return text;
}

export function invariantsFrom(agentsText) {
  const start = /^## 2\. Invariants[^\r\n]*\r?\n/m.exec(agentsText);
  if (!start) throw Error("AGENTS.md: invariant heading not found");
  const rest = agentsText.slice(start.index + start[0].length);
  const end = /^## [0-9]+\.\s/m.exec(rest);
  if (!end) throw Error("AGENTS.md: invariant section has no closing heading");
  const literal = agentsText.slice(start.index, start.index + start[0].length + end.index);
  if ((literal.match(/^- /gm) ?? []).length < 8 ||
      !literal.includes("Core is content-agnostic") ||
      !literal.includes("Emergency stop is a mandatory product invariant") ||
      !literal.includes("Security and user control")) {
    throw Error("AGENTS.md: mandatory constraints have been dropped");
  }
  return literal;
}

export function assertNoKnownSecrets(text) {
  if (/(?:ghp_[a-zA-Z0-9]{20,}|sk-(?:proj-)?[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9_.-]{24,})/.test(text)) {
    throw Error("Possible credential detected: refusing to export context");
  }
}

export function excerpt(text, query, maxLines = 10, maxBytes = 950) {
  const lines = text.split(/\r?\n/);
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).slice(0, 30);
  let best = 0;
  let high = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].toLowerCase();
    const score = terms.filter((x) => line.includes(x)).length * 3 +
      (/^\s*(?:export |##? |test\()/.test(lines[i]) ? 1 : 0);
    if (score > high) { best = i; high = score; }
  }
  const first = Math.max(0, Math.min(best - 2, lines.length - maxLines));
  let value = "";
  let last = first;
  for (let i = first; i < Math.min(first + maxLines, lines.length); i += 1) {
    const row = "    L" + (i + 1) + " | " + lines[i] + "\n";
    if (Buffer.byteLength(value + row) > maxBytes) break;
    value += row;
    last = i + 1;
  }
  return { text: value, from: first + 1, to: last, partial: lines.length > last - first };
}
