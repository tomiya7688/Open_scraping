import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const specPath = new URL("docs/developer/reliability/acceptance-gates.json", root);
const errors = [];
const validDimensions = {
  S: ["security", "security-blocking"],
  Q: ["quality", "quality-required"],
  V: ["volume", "scale-required"]
};
const validStatuses = new Set([
  "planned", "implemented_unverified", "verified", "failed", "not_applicable"
]);
const validEvidenceTypes = new Set([
  "unit", "integration", "adversarial_fixture", "os_integration", "benchmark", "release"
]);
const validScopes = new Set(["standard_collection", "automation", "distribution"]);
const seen = new Set();
const counts = { planned: 0, implemented_unverified: 0, verified: 0, failed: 0, not_applicable: 0 };

function check(condition, message) {
  if (!condition) errors.push(message);
}

let gates;
try {
  gates = JSON.parse(await readFile(specPath, "utf8"));
} catch (error) {
  console.error("Cannot read acceptance gates: " + error.message);
  process.exit(1);
}

check(gates.schema_version === "0.1-design", "Unsupported acceptance gate schema_version");
check(gates.kind === "reliability-acceptance-gates", "Incorrect gate kind");
check(typeof gates.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(gates.as_of),
  "Gate registry requires an as_of date");
check(Array.isArray(gates.entries) && gates.entries.length >= 20,
  "At least 20 security/quality/volume gates are required");

for (const [index, gate] of (Array.isArray(gates.entries) ? gates.entries : []).entries()) {
  const at = "entries[" + index + "]";
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    errors.push(at + " must be an object");
    continue;
  }
  const id = gate.id;
  if (typeof id !== "string" || !/^[SQV]\d{2}$/.test(id)) {
    errors.push(at + " must have an S/Q/V two-digit ID");
    continue;
  }
  check(!seen.has(id), id + ": duplicate gate ID");
  seen.add(id);
  const match = validDimensions[id[0]];
  check(gate.dimension === match[0], id + ": incorrect dimension");
  check(gate.gate === match[1], id + ": incorrect gate priority");
  check(Number.isInteger(gate.issue) && gate.issue > 0, id + ": issue number required");
  check(validEvidenceTypes.has(gate.verification), id + ": invalid verification type");
  check(typeof gate.assertion === "string" && gate.assertion.length >= 24,
    id + ": assertion needs a measurable description");
  check(Array.isArray(gate.required_for) && gate.required_for.length > 0 &&
    gate.required_for.every((scope) => validScopes.has(scope)),
  id + ": required_for must contain known scopes");
  check(validStatuses.has(gate.status), id + ": invalid status");
  check(Array.isArray(gate.evidence), id + ": evidence must be an array");
  if (validStatuses.has(gate.status)) counts[gate.status] += 1;
  if (["verified", "failed", "not_applicable"].includes(gate.status)) {
    check(Array.isArray(gate.evidence) && gate.evidence.length >= 1,
      id + ": verified, failed and not_applicable require concrete evidence");
  }
  for (const [i, ev] of (Array.isArray(gate.evidence) ? gate.evidence : []).entries()) {
    const ref = id + ".evidence[" + i + "]";
    check(ev && typeof ev === "object" && !Array.isArray(ev), ref + " must be an object");
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
    check(typeof ev.ref === "string" &&
      (/^https:\/\/github\.com\/tomiya7688\/Open_scraping\/(?:actions\/runs\/|pull\/|issues\/|blob\/)[^\s]+$/.test(ev.ref) ||
       /^packages\/|^docs\/|^scripts\//.test(ev.ref)),
    ref + ": evidence must be a repository ref or path");
    check(typeof ev.environment === "string" && ev.environment.trim().length >= 3,
      ref + ": environment required");
    check(typeof ev.result === "string" && ev.result.trim().length >= 3,
      ref + ": observed result required");
  }
}

for (const prefix of ["S", "Q", "V"]) {
  check([...seen].some((id) => id.startsWith(prefix)), "Missing " + prefix + " gates");
}
for (const id of ["S02", "S03", "S05", "S10", "S14", "Q02", "Q05", "V01", "V04"]) {
  check(seen.has(id), id + ": mandatory cross-cutting gate missing");
}

for (const [path, expected] of [
  ["docs/developer/reliability/README.md", ["セキュリティ", "精度", "量"]],
  ["docs/developer/reliability/security-threat-model.md", ["SSRF", "sandbox", "#78"]],
  ["docs/developer/reliability/accuracy-coverage.md", ["precision", "recall", "DataRef"]],
  ["docs/developer/reliability/volume-runtime.md", ["backpressure", "checkpoint", "Retry-After"]],
  ["docs/developer/reliability/acceptance.md", ["planned", "verified", "not_applicable"]]
]) {
  try {
    const file = await readFile(new URL(path, root), "utf8");
    for (const word of expected) check(file.includes(word), path + " missing key term: " + word);
  } catch {
    errors.push(path + ": required design document is missing");
  }
}

if (errors.length) {
  console.error("Reliability design gate validation failed:");
  for (const message of errors) console.error("- " + message);
  process.exitCode = 1;
} else {
  console.log("Reliability design registry valid (" + seen.size + " planned/verified gates):");
  console.log(counts);
}
