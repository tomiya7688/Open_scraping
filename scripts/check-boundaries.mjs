import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url);

const rules = [
  {
    dir: "packages/core",
    allowedWorkspaceDeps: new Set(["@open-scraping/contracts"]),
    forbidProcessingContracts: true,
    forbiddenImports: new Set([
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "node:http",
      "node:https",
      "node:net",
      "node:sqlite",
      "node:tls",
      "axios",
      "better-sqlite3",
      "mysql",
      "mysql2",
      "openai",
      "pg",
      "playwright",
      "puppeteer",
      "selenium-webdriver",
      "sqlite3",
      "undici"
    ])
  },
  {
    dir: "packages/host",
    allowedWorkspaceDeps: new Set([
      "@open-scraping/contracts",
      "@open-scraping/core"
    ]),
    forbiddenImports: new Set()
  },
  {
    dir: "packages/api-client",
    allowedWorkspaceDeps: new Set(["@open-scraping/contracts"]),
    forbiddenImports: new Set()
  },
  {
    dir: "apps/cli",
    allowedWorkspaceDeps: new Set(["@open-scraping/api-client"]),
    forbiddenImports: new Set([
      "node:child_process",
      "node:sqlite",
      "better-sqlite3",
      "openai",
      "playwright",
      "puppeteer",
      "sqlite3"
    ])
  },
  {
    dir: "apps/gui",
    allowedWorkspaceDeps: new Set(["@open-scraping/api-client"]),
    forbiddenImports: new Set([
      "better-sqlite3",
      "openai",
      "playwright",
      "puppeteer",
      "sqlite3"
    ])
  }
];

const errors = [];
const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
const processingContractPattern =
  /(?:browser\.session|query\.interpreter|search\.provider|candidate\.filter|download\.provider|download\.filter|data\.process|data\.select|dataset\.store|dataset\.export)\/v\d+/;

async function collectSourceFiles(dirUrl) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dirUrl, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(child)));
    } else if (/\.(?:c|m)?(?:j|t)sx?$/.test(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

function checkWorkspaceDeps(rule, pkg, pkgPath) {
  const sections = ["dependencies", "peerDependencies", "optionalDependencies"];
  for (const section of sections) {
    for (const dependency of Object.keys(pkg[section] ?? {})) {
      if (
        dependency.startsWith("@open-scraping/") &&
        !rule.allowedWorkspaceDeps.has(dependency)
      ) {
        errors.push(
          `${pkgPath}: ${section} may not depend on ${dependency}`,
        );
      }
    }
  }
}

function checkImports(rule, text, filePath) {
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];

    if (
      specifier.startsWith("@open-scraping/") &&
      !rule.allowedWorkspaceDeps.has(specifier)
    ) {
      errors.push(`${filePath}: forbidden workspace import ${specifier}`);
    }

    if (rule.forbiddenImports.has(specifier)) {
      errors.push(`${filePath}: forbidden concrete/runtime import ${specifier}`);
    }
  }

  if (rule.forbidProcessingContracts && processingContractPattern.test(text)) {
    errors.push(
      `${filePath}: core must not special-case a standard processing contract id`,
    );
  }
}

for (const rule of rules) {
  const pkgUrl = new URL(`${rule.dir}/package.json`, root);
  const pkgPath = relative(process.cwd(), pkgUrl.pathname);
  const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
  checkWorkspaceDeps(rule, pkg, pkgPath);

  const srcUrl = new URL(`${rule.dir}/src/`, root);
  for (const fileUrl of await collectSourceFiles(srcUrl)) {
    const text = await readFile(fileUrl, "utf8");
    checkImports(rule, text, relative(process.cwd(), fileUrl.pathname));
  }
}

if (errors.length > 0) {
  console.error("Dependency boundary check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("dependency boundaries: ok");
}
