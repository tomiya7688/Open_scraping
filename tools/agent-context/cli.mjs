import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPack, corpusSize } from "./selection.mjs";
import { createHandoff } from "./handoff.mjs";
import { DEFAULT_ROOT, invariantsFrom, readSource } from "./canonical.mjs";

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw Error("Use --key value arguments (see docs/developer/context-reduction.md)");
    }
    if (result[key] !== undefined) throw Error("Duplicate argument: " + key);
    result[key] = value;
  }
  return result;
}

async function explicitFile(path, maxBytes = 100 * 1024) {
  if (!path) throw Error("An explicit input file is required");
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > maxBytes) {
    throw Error("Input file must be a regular file within the size limit");
  }
  return readFile(path, "utf8");
}

export async function benchmark(root = DEFAULT_ROOT, fixture = new URL("./test/scenarios.json", import.meta.url)) {
  const scenarios = JSON.parse(await readFile(fixture, "utf8"));
  if (!Array.isArray(scenarios) || scenarios.length < 3) throw Error("Need three or more benchmark scenarios");
  const corpus = await corpusSize(root);
  const agents = await readSource(root, "AGENTS.md");
  const invariant = invariantsFrom(agents);
  const results = [];
  for (const scenario of scenarios) {
    const pack = await createPack({ root, task: scenario.task, maxFiles: scenario.max_files ?? 6 });
    const selected = pack.selected.map((x) => x.path);
    const found = scenario.expected_any.map((alternatives) =>
      alternatives.some((name) => selected.includes(name)));
    const recall = found.filter(Boolean).length / found.length;
    const preserved = pack.markdown.includes(invariant);
    const reduction = corpus.bytes > 0
      ? 1 - pack.metrics.generated_bytes / corpus.bytes
      : 0;
    results.push({
      scenario: scenario.name, expected_recall: recall,
      invariants_preserved: preserved,
      selected_paths: selected, generated_bytes: pack.metrics.generated_bytes,
      corpus_bytes: corpus.bytes,
      byte_reduction_ratio: Number(reduction.toFixed(4)),
      char_div_4_proxy: pack.metrics.characters_divided_by_4_proxy
    });
    if (recall !== 1 || !preserved || reduction <= 0 || pack.metrics.generated_bytes > 20000) {
      throw Error("Context quality gate failed: " + scenario.name + " " +
        JSON.stringify(results[results.length - 1]));
    }
  }
  return { metric_note: "Byte-based reduction vs eligible local corpus; char/4 is a rough proxy, NOT model token usage", scenarios: results };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "benchmark") {
    if (args.length) throw Error("Benchmark takes no options");
    process.stdout.write(JSON.stringify(await benchmark(), null, 2) + "\n");
  } else if (command === "pack") {
    const opts = options(args);
    const allowed = new Set(["--task", "--task-file", "--changed", "--max-files", "--limit-bytes", "--issue", "--ref"]);
    for (const key of Object.keys(opts)) if (!allowed.has(key)) throw Error("Unknown option " + key);
    if (Boolean(opts["--task"]) === Boolean(opts["--task-file"])) {
      throw Error("Specify exactly one of --task or --task-file");
    }
    const task = opts["--task"] ?? await explicitFile(opts["--task-file"], 32 * 1024);
    const pack = await createPack({
      task, issue: opts["--issue"] ?? "", ref: opts["--ref"] ?? "",
      changedPaths: opts["--changed"] ? opts["--changed"].split(",") : [],
      maxFiles: opts["--max-files"] ? Number(opts["--max-files"]) : 6,
      limitBytes: opts["--limit-bytes"] ? Number(opts["--limit-bytes"]) : 20000
    });
    process.stdout.write(pack.markdown);
  } else if (command === "handoff") {
    const opts = options(args);
    if (Object.keys(opts).length !== 1 || !opts["--input"]) {
      throw Error("Usage: handoff --input progress.json");
    }
    const data = JSON.parse(await explicitFile(opts["--input"]));
    const report = await createHandoff({ data });
    process.stdout.write(report.markdown);
  } else {
    throw Error("Usage: node tools/agent-context/cli.mjs <pack|handoff|benchmark> [options]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Deliberately do not echo user-provided content or credentials.
    console.error("Context workflow error: " + error.message);
    process.exitCode = 1;
  });
}
