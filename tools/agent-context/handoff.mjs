import {
  DEFAULT_ROOT, assertNoKnownSecrets, invariantsFrom, readSource, sha256
} from "./canonical.mjs";

const TEST_RESULTS = new Set(["passed", "failed", "not_run"]);
const HANDOFF_FIELDS = new Set([
  "schema_version", "issue", "pr", "branch", "base", "goal",
  "acceptance", "changes", "tests", "blockers", "dependencies", "next_actions"
]);

function string(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) {
    throw Error(name + " must be a non-empty string <=4000 characters");
  }
  return value;
}

function strings(value, name, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw Error(name + " must be an array of at most " + maximum + " items");
  }
  return value.map((item, index) => string(item, name + "[" + index + "]"));
}

export function validateHandoff(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw Error("Handoff must be a JSON object");
  }
  for (const key of Object.keys(data)) {
    if (!HANDOFF_FIELDS.has(key)) throw Error("Unknown handoff field: " + key);
  }
  if (data.schema_version !== "1") throw Error("Unsupported handoff schema version");
  for (const key of ["issue", "pr", "branch", "base", "goal"]) string(data[key], key);
  for (const key of ["acceptance", "blockers", "dependencies", "next_actions"]) {
    strings(data[key], key);
  }
  if (!Array.isArray(data.changes) || data.changes.length > 100) {
    throw Error("changes must be an array");
  }
  for (const [index, change] of data.changes.entries()) {
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      throw Error("Invalid change entry " + index);
    }
    string(change.path, "changes.path");
    string(change.summary, "changes.summary");
    for (const key of Object.keys(change)) {
      if (!["path", "summary"].includes(key)) throw Error("Unknown change field: " + key);
    }
  }
  if (!Array.isArray(data.tests) || data.tests.length > 100) {
    throw Error("tests must be an array");
  }
  for (const [index, item] of data.tests.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw Error("Invalid test " + index);
    }
    string(item.command, "tests.command");
    if (!TEST_RESULTS.has(item.result)) throw Error("Invalid test result: " + item.result);
    if (item.result === "not_run") {
      string(item.reason, "Not-run reason");
      if (item.evidence !== undefined) throw Error("Unrun tests must not claim evidence");
    } else {
      string(item.evidence, "Test observation or CI URL");
      if (item.reason !== undefined) throw Error("Observed tests cannot use not-run reason");
    }
    for (const key of Object.keys(item)) {
      if (!["command", "result", "evidence", "reason"].includes(key)) {
        throw Error("Unknown test field: " + key);
      }
    }
  }
  assertNoKnownSecrets(JSON.stringify(data));
  return structuredClone(data);
}

function inline(value) {
  // Strings are quoted, so a user-supplied heading/newline cannot become an instruction.
  return JSON.stringify(value);
}

function listing(items, toString) {
  return items.length ? items.map((item) => "- " + toString(item)).join("\n") : "- None";
}

export async function createHandoff({
  root = DEFAULT_ROOT, data, limitBytes = 65536
}) {
  const input = validateHandoff(data);
  const agents = await readSource(root, "AGENTS.md");
  const canonical = invariantsFrom(agents);
  const markdown = "# AI development handoff (explicitly supplied facts)\n\n" +
    "Do not assume statements are verified. Re-check current Issue, PR, branch and CI " +
    "before continuing work. This generator never fetches GitHub state or executes tests. " +
    "Do not compress away the following canonical constraints.\n\n" +
    "## Source metadata\n\n" +
    "- \`AGENTS.md\` SHA-256: " + sha256(agents) + "\n" +
    "- Invariant excerpt SHA-256: " + sha256(canonical) + "\n" +
    "- Schema: " + input.schema_version + "\n" +
    "- Issue: " + inline(input.issue) + "\n" +
    "- PR: " + inline(input.pr) + "\n" +
    "- Branch: " + inline(input.branch) + "\n" +
    "- Base: " + inline(input.base) + "\n" +
    "- Goal: " + inline(input.goal) + "\n\n" +
    "## Acceptance criteria (caller-supplied)\n\n" +
    listing(input.acceptance, inline) + "\n\n" +
    "## Files and changes (caller-supplied)\n\n" +
    listing(input.changes, (c) => inline(c.path) + " — " + inline(c.summary)) + "\n\n" +
    "## Test observations (not independently verified)\n\n" +
    listing(input.tests, (t) => inline(t.command) + " — " + t.result +
      " — " + (t.result === "not_run" ? "reason: " + inline(t.reason) :
        "observation: " + inline(t.evidence))) + "\n\n" +
    "## Dependencies and blockers\n\n" +
    listing(input.dependencies, inline) + "\n\n" +
    listing(input.blockers, inline) + "\n\n" +
    "## Next actions\n\n" +
    listing(input.next_actions, inline) + "\n\n" +
    "## Canonical rules — exact AGENTS.md excerpt\n\n" + canonical;
  if (!markdown.includes(canonical)) throw Error("Lost critical invariant context");
  if (Buffer.byteLength(markdown) > limitBytes) {
    throw Error("Handoff exceeds output budget. Never silently truncate decisions or rules.");
  }
  return {
    markdown,
    metadata: {
      issue: input.issue,
      pr: input.pr,
      branch: input.branch,
      base: input.base,
      critical_sha256: sha256(canonical),
      passed_claims_with_observation: input.tests.filter((t) => t.result === "passed").length,
      explicitly_not_run: input.tests.filter((t) => t.result === "not_run").length
    }
  };
}
