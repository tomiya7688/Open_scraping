import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_ROOT, MAX_FILE_BYTES, invariantsFrom, readSource, safePath, sha256
} from "../canonical.mjs";
import { createPack, selectSources, corpusSize } from "../selection.mjs";
import { createHandoff, validateHandoff } from "../handoff.mjs";
import { benchmark } from "../cli.mjs";

const validHandoff = () => ({
  schema_version: "1",
  issue: "#76",
  pr: "#77",
  branch: "feat/context",
  base: "docs/ai-agent-common-instructions",
  goal: "Preserve critical constraints while reducing retrieved code",
  acceptance: ["Review target modules", "Retain invariant text"],
  changes: [{ path: "tools/agent-context/selection.mjs", summary: "Select relevant sources" }],
  tests: [
    { command: "npm run verify", result: "passed", evidence: "https://github.com/example/repo/actions/runs/123" },
    { command: "OS shortcut test", result: "not_run", reason: "OS-level integration is out of scope" }
  ],
  blockers: ["PR #73 not merged"],
  dependencies: ["PR #73"],
  next_actions: ["Review PR"]
});

test("security: traversal, hidden data and non-text paths are not context sources", async () => {
  for (const path of [
    "../secrets.md", "/tmp/secrets.md", ".env", ".env.production",
    "node_modules/private.md", "dist/index.js", "README.md/../private.md",
    "docs\\private.md", "credentials/password.md", "keys.pem"
  ]) {
    assert.throws(() => safePath(path), /path|source/i, path);
  }
  assert.equal(safePath("packages/core/src/execution.ts"), "packages/core/src/execution.ts");

  const root = await mkdtemp(join(tmpdir(), "os-context-test-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "safe");
    await writeFile(join(root, "oversized.md"), "x".repeat(MAX_FILE_BYTES + 1));
    await assert.rejects(() => readSource(root, "oversized.md"), /eligible/);
    await assert.rejects(() => readSource(root, "missing.md"), /ENOENT/);
    if (process.platform !== "win32") {
      await symlink(join(root, "AGENTS.md"), join(root, "link.md"));
      await assert.rejects(() => readSource(root, "link.md"), /eligible/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical invariants are copied byte-for-byte and SHA-256 matches the source", async () => {
  const content = await readSource(DEFAULT_ROOT, "AGENTS.md");
  const rules = invariantsFrom(content);
  assert.match(rules, /Core is content-agnostic/);
  assert.match(rules, /Emergency stop is a mandatory product invariant/);
  assert.match(rules, /Security and user control/);
  assert.equal(sha256(rules).length, 64);

  const pack = await createPack({
    root: DEFAULT_ROOT,
    task: "FlowRun core stop cancellation and recovery",
    changedPaths: ["packages/core/src/execution.ts"],
    maxFiles: 6
  });
  assert.ok(pack.markdown.includes(rules), "mandatory rules must be verbatim");
  assert.equal(pack.metrics.invariant_sha256, sha256(rules));
  assert.ok(pack.selected.some((source) => source.path === "packages/core/src/execution.ts"));
  assert.match(pack.markdown, /L[0-9]+ \| /);
  assert.match(pack.markdown, /partial excerpt/);
  assert.ok(pack.metrics.generated_bytes < (await corpusSize(DEFAULT_ROOT)).bytes);
  const fullSource = await readSource(DEFAULT_ROOT, "packages/core/src/execution.ts");
  const selected = pack.selected.find((s) => s.path === "packages/core/src/execution.ts");
  assert.equal(selected.full_sha256, sha256(fullSource));
});

test("missing or too many explicit paths never pretend to have been retrieved", async () => {
  await assert.rejects(
    () => selectSources({ task: "core", changedPaths: ["no/such/file.ts"] }),
    /ENOENT/
  );
  await assert.rejects(
    () => selectSources({
      task: "core",
      changedPaths: ["packages/core/src/execution.ts", "packages/core/README.md"],
      maxFiles: 1
    }),
    /Explicitly requested/
  );
  await assert.rejects(
    () => createPack({ task: "FlowRun stop", limitBytes: 5000, maxFiles: 6 }),
    /exceeds|budget/
  );
});

test("known credential patterns abort context export instead of printing a token", async () => {
  const candidate = "ghp_" + "T".repeat(30);
  await assert.rejects(
    () => createPack({ task: "check token " + candidate }),
    /credential/
  );

  const tmp = await mkdtemp(join(tmpdir(), "os-context-secret-"));
  try {
    const agents = await readSource(DEFAULT_ROOT, "AGENTS.md");
    await writeFile(join(tmp, "AGENTS.md"), agents);
    await writeFile(join(tmp, "document.md"), "Bearer " + "X".repeat(40));
    await assert.rejects(
      () => createPack({ root: tmp, task: "document", changedPaths: ["document.md"] }),
      /credential/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("handoff validates evidence and retains every field without summarization", async () => {
  const input = validHandoff();
  const report = await createHandoff({ data: input });
  const rules = invariantsFrom(await readSource(DEFAULT_ROOT, "AGENTS.md"));
  assert.ok(report.markdown.includes(rules));
  assert.equal(report.metadata.passed_claims_with_observation, 1);
  assert.equal(report.metadata.explicitly_not_run, 1);
  for (const value of [input.goal, input.blockers[0], input.next_actions[0]]) {
    assert.ok(report.markdown.includes(value));
  }

  const withoutEvidence = validHandoff();
  delete withoutEvidence.tests[0].evidence;
  assert.throws(() => validateHandoff(withoutEvidence), /observation/);

  const missingReason = validHandoff();
  delete missingReason.tests[1].reason;
  assert.throws(() => validateHandoff(missingReason), /Not-run reason/);

  const forgedStatus = validHandoff();
  forgedStatus.tests[0].result = "successfully_maybe";
  assert.throws(() => validateHandoff(forgedStatus), /Invalid test result/);

  const extraFields = validHandoff();
  extraFields.tool_memory = "unknown";
  assert.throws(() => validateHandoff(extraFields), /Unknown handoff field/);

  const secret = validHandoff();
  secret.goal = "Bearer " + "A".repeat(40);
  assert.throws(() => validateHandoff(secret), /credential/);

  await assert.rejects(
    () => createHandoff({ data: validHandoff(), limitBytes: 1000 }),
    /exceeds/
  );
});

test("benchmark checks actual source recall, verbatim rules and output-size improvement", async () => {
  const result = await benchmark(DEFAULT_ROOT);
  assert.equal(result.scenarios.length, 4);
  for (const scenario of result.scenarios) {
    assert.equal(scenario.expected_recall, 1);
    assert.equal(scenario.invariants_preserved, true);
    assert.ok(scenario.byte_reduction_ratio > 0);
  }
  assert.match(result.metric_note, /NOT model token usage/);
});
