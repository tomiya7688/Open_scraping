import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROOT } from "../canonical.mjs";
import { listWorkspaces, routeChanges, routingMarkdown } from "../change-router.mjs";

const names = (items) => items.map((item) => item.name);
const commands = (plan) => plan.suggested_checks.map((item) => item.command);
const paths = (plan) => plan.read_candidates.map((item) => item.path);

test("contract change routes to real downstream workspaces, contract docs and tests", async () => {
  const plan = await routeChanges({
    changedPaths: ["packages/contracts/src/validator.ts"],
    task: "change FlowConfig manifest validator"
  });
  assert.deepEqual(plan.touched_workspaces.map((ws) => ws.name), ["@open-scraping/contracts"]);
  assert.deepEqual(
    new Set(plan.potentially_affected_workspaces.map((ws) => ws.name)),
    new Set([
      "@open-scraping/contracts",
      "@open-scraping/core",
      "@open-scraping/host",
      "@open-scraping/api-client",
      "@open-scraping/cli",
      "@open-scraping/gui"
    ])
  );
  for (const command of [
    "npm test --workspace @open-scraping/contracts",
    "npm test --workspace @open-scraping/core",
    "npm test --workspace @open-scraping/host",
    "npm run verify"
  ]) {
    assert.ok(commands(plan).includes(command), command);
  }
  assert.ok(paths(plan).includes("packages/contracts/test/contracts.test.mjs"));
  assert.ok(paths(plan).includes("packages/core/test/execution.test.mjs"));
  assert.ok(paths(plan).some((p) => p === "docs/contracts.md" ||
    p === "docs/developer/contracts.md"));
  assert.ok(plan.review_gates.some((s) => s.includes("compatibility")));
  assert.ok(plan.read_candidates.every((x) => x.status === "candidate_not_read_by_agent"));
  assert.ok(plan.suggested_checks.every((x) => x.status === "recommended_not_executed"));
});

test("host and core changes have separate routing and architecture checks", async () => {
  const host = await routeChanges({
    changedPaths: ["packages/host/src/component-host.ts"],
    task: "fix permission rejection"
  });
  assert.deepEqual(names(host.potentially_affected_workspaces), ["@open-scraping/host"]);
  assert.ok(paths(host).includes("packages/host/test/component-host.test.mjs"));
  assert.ok(host.review_gates.some((s) => s.includes("default-deny")));
  assert.ok(!commands(host).includes("npm test --workspace @open-scraping/contracts"));

  const core = await routeChanges({
    changedPaths: ["packages/core/src/execution.ts"],
    task: "Esc global emergency stop for every active run"
  });
  assert.ok(names(core.potentially_affected_workspaces).includes("@open-scraping/host"));
  assert.ok(core.review_gates.some((s) => s.includes("Core must not depend")));
  assert.ok(core.review_gates.some((s) => s.includes("OS-specific acceptance")));
});

test("API client changes discover both CLI and GUI consumers with missing test coverage warning", async () => {
  const plan = await routeChanges({
    changedPaths: ["packages/api-client/src/index.ts"]
  });
  assert.deepEqual(
    new Set(names(plan.potentially_affected_workspaces)),
    new Set(["@open-scraping/api-client", "@open-scraping/cli", "@open-scraping/gui"])
  );
  assert.ok(commands(plan).includes("npm run typecheck --workspace @open-scraping/gui"));
  assert.ok(plan.warnings.some((s) => s.includes("has no test script")));
  assert.ok(plan.review_gates.some((s) => s.includes("public API client")));
});

test("docs-only changes avoid unrelated workspace tests but retain documentation and CI gates", async () => {
  const plan = await routeChanges({
    changedPaths: ["docs/developer/context-reduction.md"]
  });
  assert.deepEqual(plan.touched_workspaces, []);
  assert.deepEqual(plan.potentially_affected_workspaces, []);
  assert.ok(commands(plan).includes("npm run check:docs"));
  assert.ok(commands(plan).includes("npm run verify"));
  assert.ok(!commands(plan).some((s) => s.startsWith("npm test --workspace")));
});

test("changes to agent tooling suggest its existing CI scripts, not scraper tests", async () => {
  const plan = await routeChanges({
    changedPaths: ["tools/agent-context/change-router.mjs", "AGENTS.md"]
  });
  assert.ok(commands(plan).includes("npm run check:context"));
  assert.ok(commands(plan).includes("npm run check:agents"));
  assert.ok(commands(plan).includes("npm run check:docs"));
  assert.ok(!commands(plan).includes("npm test --workspace @open-scraping/core"));
  assert.ok(paths(plan).includes("docs/developer/context-reduction.md"));
});

test("unknown or new paths are visibly unverified, never invented as read", async () => {
  const plan = await routeChanges({
    changedPaths: ["packages/host/src/not-yet-created.ts", "new-domain/adapter.ts"]
  });
  assert.ok(plan.warnings.some((s) => s.includes("not-yet-created.ts")));
  assert.ok(plan.warnings.some((s) => s.includes("no routing rule")));
  assert.ok(!paths(plan).includes("packages/host/src/not-yet-created.ts"));
  assert.ok(!paths(plan).includes("new-domain/adapter.ts"));
  assert.ok(commands(plan).includes("npm run verify"));
  await assert.rejects(
    () => routeChanges({ changedPaths: ["../../secrets.md"] }),
    /path/i
  );
  await assert.rejects(
    () => routeChanges({ changedPaths: [] }),
    /1–40/
  );
  await assert.rejects(
    () => routeChanges({ changedPaths: Array(41).fill("README.md") }),
    /1–40/
  );
});

test("actual dependency graph is loaded from workspace manifests rather than hardcoded names", async () => {
  const root = await mkdtemp(join(tmpdir(), "os-route-test-"));
  try {
    await mkdir(join(root, "packages/alpha/src"), { recursive: true });
    await mkdir(join(root, "apps/beta/src"), { recursive: true });
    await mkdir(join(root, "packages/alpha/test"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      workspaces: ["packages/*", "apps/*"]
    }));
    await writeFile(join(root, "packages/alpha/package.json"), JSON.stringify({
      name: "@open-scraping/alpha", scripts: { test: "node --test" }
    }));
    await writeFile(join(root, "apps/beta/package.json"), JSON.stringify({
      name: "@open-scraping/beta",
      dependencies: { "@open-scraping/alpha": "0.0.0" },
      scripts: { typecheck: "tsc --noEmit" }
    }));
    await writeFile(join(root, "packages/alpha/src/example.ts"), "export const answer = 42;\n");
    await writeFile(join(root, "packages/alpha/test/example.test.mjs"), "// placeholder\n");
    const workspaces = await listWorkspaces(root);
    assert.equal(workspaces.length, 2);
    const plan = await routeChanges({
      root,
      changedPaths: ["packages/alpha/src/example.ts"]
    });
    assert.deepEqual(
      new Set(names(plan.potentially_affected_workspaces)),
      new Set(["@open-scraping/alpha", "@open-scraping/beta"])
    );
    assert.ok(paths(plan).includes("packages/alpha/test/example.test.mjs"));
    assert.ok(commands(plan).includes("npm test --workspace @open-scraping/alpha"));
    assert.ok(commands(plan).includes("npm run typecheck --workspace @open-scraping/beta"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("router returns both machine-readable JSON and concise human instructions", async () => {
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  const result = execFileSync(process.execPath, [
    cli, "route", "--changed", "packages/host/src/registry.ts",
    "--format", "json"
  ], { cwd: DEFAULT_ROOT, encoding: "utf8" });
  const plan = JSON.parse(result);
  assert.equal(plan.kind, "open-scraping-change-routing");
  assert.ok(names(plan.potentially_affected_workspaces).includes("@open-scraping/host"));
  const text = routingMarkdown(plan);
  assert.match(text, /NOT executed/);
  assert.match(text, /npm test --workspace @open-scraping\/host/);
});
