import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_ROOT, readSource, safePath } from "./canonical.mjs";

/**
 * Open_scraping-specific change routing.
 * Uses actual npm workspace manifests and test files rather than a static
 * module graph. Suggestions are not proof that tests passed or that
 * every affected file was found.
 */
const DOC_CANDIDATES = {
  contracts: [["packages/contracts/README.md"], ["docs/developer/contracts.md", "docs/contracts.md"]],
  core: [["packages/core/README.md"], ["docs/developer/runtime.md", "docs/runtime.md"],
    ["docs/developer/design.md", "docs/design.md"]],
  host: [["packages/host/README.md"], ["docs/developer/component-host.md", "docs/component-host.md"]],
  "api-client": [["docs/developer/api.md", "docs/api.md"]],
  cli: [["apps/README.md"], ["docs/developer/api.md", "docs/api.md"]],
  gui: [["apps/README.md"], ["docs/developer/api.md", "docs/api.md"]],
  components: [["docs/developer/components.md", "docs/components.md"],
    ["docs/developer/contracts.md", "docs/contracts.md"]],
  flows: [["docs/developer/contracts.md", "docs/contracts.md"],
    ["docs/developer/customization.md", "docs/customization.md"]],
  distributions: [["docs/developer/customization.md", "docs/customization.md"]],
  "agent-context": [["docs/developer/context-reduction.md"], ["docs/developer/ai-collaboration.md"]]
};

function groupFor(path, knownWorkspace) {
  if (knownWorkspace) return knownWorkspace.path.split("/").at(-1);
  if (path.startsWith("tools/agent-context/")) return "agent-context";
  if (path.startsWith("components/")) return "components";
  if (path.startsWith("flows/")) return "flows";
  if (path.startsWith("distributions/")) return "distributions";
  if (path.startsWith("docs/") || path === "README.md" || path === "CONTRIBUTING.md") return "documentation";
  if (path === "AGENTS.md" || path === "CLAUDE.md" ||
      path === ".github/copilot-instructions.md") return "ai-guidance";
  if (path.startsWith("scripts/") || path === "package.json" ||
      path.startsWith(".github/workflows/")) return "infrastructure";
  return "unmapped";
}

async function existsAsSource(root, path) {
  try {
    await readSource(root, path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function firstExisting(root, paths) {
  for (const path of paths) {
    if (await existsAsSource(root, path)) return path;
  }
  return undefined;
}

export async function listWorkspaces(root = DEFAULT_ROOT) {
  const manifest = JSON.parse(await readSource(root, "package.json"));
  const globs = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(globs)) throw Error("Root package.json must declare npm workspaces");
  const entries = [];
  for (const glob of globs) {
    if (glob !== "packages/*" && glob !== "apps/*") {
      throw Error("Unrecognized workspace pattern: " + glob);
    }
    for (const dir of await readdir(resolve(root, glob.slice(0, -2)), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const path = glob.slice(0, -1) + dir.name;
      const packageJsonPath = path + "/package.json";
      if (!(await existsAsSource(root, packageJsonPath))) continue;
      const info = JSON.parse(await readSource(root, packageJsonPath));
      if (typeof info.name !== "string" || !info.name.startsWith("@open-scraping/")) {
        throw Error("Unexpected workspace name in " + packageJsonPath);
      }
      entries.push({
        name: info.name,
        path,
        scripts: info.scripts ?? {},
        dependencies: Object.keys({
          ...info.dependencies, ...info.devDependencies,
          ...info.peerDependencies, ...info.optionalDependencies
        }).filter((name) => name.startsWith("@open-scraping/"))
      });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const unique = new Set(entries.map((entry) => entry.name));
  if (unique.size !== entries.length) throw Error("Duplicate workspace names");
  return entries;
}

function owningWorkspace(workspaces, path) {
  return workspaces.find((ws) => path.startsWith(ws.path + "/"));
}

function affectedWorkspaces(workspaces, touched) {
  const active = new Set(touched.map((ws) => ws.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const ws of workspaces) {
      if (!active.has(ws.name) && ws.dependencies.some((dep) => active.has(dep))) {
        active.add(ws.name);
        changed = true;
      }
    }
  }
  return workspaces.filter((ws) => active.has(ws.name));
}

async function testPaths(root, workspace) {
  const base = workspace.path + "/test";
  let tests;
  try {
    tests = await readdir(resolve(root, base), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  return tests.filter((x) => x.isFile() && /\.test\.(?:mjs|js|ts)$/.test(x.name))
    .map((x) => base + "/" + x.name).sort();
}

/**
 * Candidate reads and test commands. This does not execute tests, inspect
 * the actual diff, or fetch Issue/PR status from GitHub.
 */
export async function routeChanges({ root = DEFAULT_ROOT, changedPaths, task = "" }) {
  if (!Array.isArray(changedPaths) || !changedPaths.length || changedPaths.length > 40) {
    throw Error("Provide 1–40 changed paths; routing does not infer unstated changes");
  }
  if (typeof task !== "string" || task.length > 4096) throw Error("Invalid task description");
  const paths = [...new Set(changedPaths.map(safePath))];
  const workspaces = await listWorkspaces(root);
  const owning = paths.map((path) => owningWorkspace(workspaces, path));
  const groups = [...new Set(paths.map((path, i) => groupFor(path, owning[i])))];
  const touched = [...new Set(owning.filter(Boolean))];
  const affected = affectedWorkspaces(workspaces, touched);
  const warnings = [];
  const reads = [];
  const commands = [];
  const reviewGates = [];
  const candidateSet = new Set();
  const commandSet = new Set();

  function addRead(path, purpose) {
    if (candidateSet.has(path)) return;
    candidateSet.add(path);
    reads.push({ path, purpose, status: "candidate_not_read_by_agent" });
  }
  function addCommand(command, reason) {
    if (commandSet.has(command)) return;
    commandSet.add(command);
    commands.push({ command, reason, status: "recommended_not_executed" });
  }

  for (const path of paths) {
    if (await existsAsSource(root, path)) {
      addRead(path, "Changed path — inspect actual diff and full file");
    } else {
      warnings.push("Changed path is absent from this checkout: " + path +
        " (new file, deleted file, stale branch, or unsupported path). Verify the actual PR diff.");
    }
  }

  for (const group of groups) {
    for (const choices of DOC_CANDIDATES[group] ?? []) {
      const candidate = await firstExisting(root, choices);
      if (candidate) addRead(candidate, "Applicable " + group + " design or review reference");
    }
  }

  for (const ws of affected) {
    for (const path of await testPaths(root, ws)) {
      addRead(path, touched.some((own) => own.name === ws.name)
        ? "Directly affected workspace test"
        : "Downstream workspace test (dependency inferred from package.json)");
    }
    if (ws.scripts.test) {
      addCommand("npm test --workspace " + ws.name,
        touched.some((own) => own.name === ws.name)
          ? "Directly changed workspace"
          : "Potential downstream impact through declared workspace dependencies");
    } else if (ws.scripts.typecheck) {
      addCommand("npm run typecheck --workspace " + ws.name,
        "Dependent workspace declares no test script; typecheck is not behavioral coverage");
      warnings.push(ws.path + " has no test script; add integration tests if its behavior can change.");
    } else {
      warnings.push(ws.path + " declares no test/typecheck script; verify behavior manually.");
    }
  }

  if (groups.includes("agent-context") || groups.includes("ai-guidance")) {
    addRead("AGENTS.md", "Canonical shared agent instructions");
    addCommand("npm run check:agents", "Verify AI tool entry points and links");
    addCommand("npm run check:context", "Test local context-reduction tools and benchmark");
  }
  if (groups.includes("documentation") || groups.includes("ai-guidance") ||
      paths.some((p) => p.endsWith(".md"))) {
    addCommand("npm run check:docs", "Check local documentation links and example JSON");
  }
  if (groups.includes("infrastructure")) {
    addCommand("npm run check:boundaries", "Recheck architecture enforcement after scripts or CI changes");
  }

  if (groups.includes("contracts")) {
    reviewGates.push("Public contract/schema change: verify backward compatibility, manifests, and serialized examples.");
  }
  if (groups.includes("core")) {
    reviewGates.push("Core must not depend on browser/search/HTTP/model/dataset SDKs; check failure and cancellation races.");
  }
  if (groups.includes("host")) {
    reviewGates.push("Host must enforce permission default-deny, explicit bindings and owned-worker cancellation.");
  }
  if (groups.some((g) => ["api-client", "cli", "gui"].includes(g))) {
    reviewGates.push("CLI/GUI must call the public API client; no Core/Host or concrete processing SDK imports.");
  }
  if (groups.some((g) => ["components", "flows", "distributions"].includes(g))) {
    reviewGates.push("Concrete processing belongs in replaceable components; unavailable providers must not silently succeed.");
    warnings.push("Concrete components / flows may lack tests on this branch: mock, end-to-end, and real-site coverage are separate.");
  }
  if (/emergency|非常停止|esc|physical mouse/i.test(task + " " + paths.join(" "))) {
    reviewGates.push("Global Esc and physical mouse emergency stop require OS-specific acceptance tests; mock/CI success alone is insufficient.");
  }
  if (groups.includes("unmapped")) {
    warnings.push("Some paths have no routing rule; inspect imports/call sites, related docs and tests manually.");
  }
  if (groups.includes("documentation") && !groups.some((g) => !["documentation", "unmapped"].includes(g))) {
    reviewGates.push("Check whether documentation describes merged behavior or only a proposed design.");
  }

  addCommand("npm run verify", "Final repository CI gate (does not prove real sites or OS hooks)");
  const workspaceResult = (ws) => ({ name: ws.name, path: ws.path });
  return {
    schema_version: "1",
    kind: "open-scraping-change-routing",
    method: "Candidate list only; read actual source and diff; commands are not executed.",
    changed_paths: paths,
    groups,
    touched_workspaces: touched.map(workspaceResult),
    potentially_affected_workspaces: affected.map(workspaceResult),
    read_candidates: reads,
    suggested_checks: commands,
    review_gates: reviewGates,
    warnings
  };
}

export function routingMarkdown(plan) {
  const lines = [
    "# Open_scraping change-routing candidates",
    "",
    "Local advisory output only. Recheck actual Issue/PR, source, tests and present branch.",
    "",
    "## Areas",
    "",
    plan.groups.join(", "),
    "",
    "## Read first (not yet verified by the AI)",
    "",
    ...plan.read_candidates.map((item) => "- " + item.path + " — " + item.purpose),
    "",
    "## Suggested checks (NOT executed)",
    "",
    ...plan.suggested_checks.map((item) => "- " + item.command + " — " + item.reason),
    "",
    "## Human review / escalation",
    "",
    ...(plan.review_gates.length ? plan.review_gates.map((value) => "- " + value) : ["- Follow the relevant Issue acceptance criteria."]),
    "",
    "## Warnings",
    "",
    ...(plan.warnings.length ? plan.warnings.map((value) => "- " + value) : ["- None"]),
    ""
  ];
  return lines.join("\n");
}
