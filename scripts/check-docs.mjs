import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const docsRoot = resolve(root, "docs");
const errors = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const files = await walk(docsRoot);

for (const file of files) {
  if (extname(file) === ".json") {
    try {
      JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      errors.push(`${file}: invalid JSON: ${error.message}`);
    }
  }

  if (extname(file) !== ".md") continue;

  const markdown = await readFile(file, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim();

    if (
      rawTarget.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
    ) {
      continue;
    }

    const target = decodeURIComponent(rawTarget.split("#", 1)[0].split("?", 1)[0]);
    if (!target) continue;

    const resolved = resolve(dirname(file), target);
    if (!(await exists(resolved))) {
      errors.push(`${file}: broken local link -> ${rawTarget}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Documentation check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("documentation links/json: ok");
}
