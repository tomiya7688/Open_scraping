import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateDataRef,
  validateFlowConfig,
  validateOperationMessage
} from "../dist/index.js";

function port(type, options = {}) {
  return { type, ...options };
}

function manifest({
  id,
  contract,
  operations,
  bindings = {},
  capabilities = []
}) {
  return {
    schema_version: "0.1",
    kind: "component-manifest",
    id,
    version: "0.0.0-example",
    protocol: {
      name: "open-scraping.component-rpc",
      version: "1"
    },
    contracts: [
      {
        id: contract,
        capabilities,
        operations
      }
    ],
    settings_schema: {
      type: "object"
    },
    bindings,
    permissions: [],
    cancellation: {
      mode: "cooperative",
      grace_ms: 1000
    },
    runtime: {
      transport: "stdio-jsonrpc",
      command: "example-worker"
    }
  };
}

const manifests = [
  manifest({
    id: "example.local-uppercase",
    contract: "example.text-transform/v1",
    operations: [
      {
        name: "transform",
        inputs: {
          text: port("example.text/v1", {
            schema: { type: "string" }
          })
        },
        outputs: {
          text: port("example.text/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.browser-playwright",
    contract: "browser.session/v1",
    operations: [
      {
        name: "open",
        inputs: {},
        outputs: {
          session: port("browser.session-ref/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.site-search",
    contract: "search.provider/v1",
    bindings: {
      browser: {
        contract: "browser.session/v1"
      }
    },
    operations: [
      {
        name: "search",
        inputs: {
          query: port("scraping.search-query/v1")
        },
        outputs: {
          candidates: port("scraping.candidates/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.asset-download",
    contract: "download.provider/v1",
    bindings: {
      browser: {
        contract: "browser.session/v1"
      }
    },
    operations: [
      {
        name: "fetch",
        inputs: {
          candidates: port("scraping.candidates/v1")
        },
        outputs: {
          batch: port("scraping.item-batch/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.local-dataset-store",
    contract: "dataset.store/v1",
    operations: [
      {
        name: "ingest",
        inputs: {
          batch: port("scraping.item-batch/v1")
        },
        outputs: {
          collection: port("scraping.collection/v1")
        }
      },
      {
        name: "snapshot",
        inputs: {
          collection: port("scraping.collection/v1")
        },
        outputs: {
          snapshot: port("scraping.collection-snapshot/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.files-manifest-export",
    contract: "dataset.export/v1",
    bindings: {
      storage: {
        contract: "dataset.store/v1"
      }
    },
    operations: [
      {
        name: "export",
        inputs: {
          source: port("scraping.collection-snapshot/v1", {
            accepts: ["scraping.selection/v1"]
          })
        },
        outputs: {
          export: port("scraping.export/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.local-query-interpreter",
    contract: "query.interpreter/v1",
    operations: [
      {
        name: "interpret",
        inputs: {
          text: port("example.text/v1")
        },
        outputs: {
          query: port("scraping.search-query/v1"),
          intent: port("scraping.intent/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.image-condition-analysis",
    contract: "data.process/v1",
    bindings: {
      storage: {
        contract: "dataset.store/v1"
      }
    },
    operations: [
      {
        name: "process",
        inputs: {
          source: port("scraping.collection-snapshot/v1"),
          intent: port("scraping.intent/v1")
        },
        outputs: {
          result: port("scraping.analysis/v1")
        }
      }
    ]
  }),
  manifest({
    id: "example.image-selection",
    contract: "data.select/v1",
    bindings: {
      storage: {
        contract: "dataset.store/v1"
      }
    },
    operations: [
      {
        name: "select",
        inputs: {
          source: port("scraping.collection-snapshot/v1"),
          analysis: port("scraping.analysis/v1"),
          intent: port("scraping.intent/v1")
        },
        outputs: {
          selection: port("scraping.selection/v1")
        }
      }
    ]
  })
];

async function example(name) {
  const url = new URL(`../../../docs/examples/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function codes(result) {
  return new Set(result.diagnostics.map((diagnostic) => diagnostic.code));
}

test("the three documented FlowConfig examples pass full validation", async () => {
  for (const name of [
    "local-processing.json",
    "site-search.json",
    "site-search-with-extensions.json"
  ]) {
    const flow = await example(name);
    const result = validateFlowConfig(flow, manifests);
    assert.equal(
      result.ok,
      true,
      `${name}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

test("dangling references are rejected without implicit rewiring", async () => {
  const flow = await example("local-processing.json");
  flow.nodes[0].inputs.text.$ref = "nodes.missing.outputs.text";

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("DANGLING_REF"));
});

test("duplicate node ids are rejected", async () => {
  const flow = await example("local-processing.json");
  flow.nodes.push(clone(flow.nodes[0]));

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("DUPLICATE_NODE_ID"));
});

test("node dependency cycles are rejected", async () => {
  const flow = await example("local-processing.json");
  const a = clone(flow.nodes[0]);
  a.id = "a";
  a.inputs.text = { $ref: "nodes.b.outputs.text" };
  const b = clone(flow.nodes[0]);
  b.id = "b";
  b.inputs.text = { $ref: "nodes.a.outputs.text" };
  flow.nodes = [a, b];
  flow.outputs.text.$ref = "nodes.a.outputs.text";

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("NODE_CYCLE"));
});

test("component binding cycles are rejected", async () => {
  const flow = await example("local-processing.json");
  flow.components.transform.bindings = { self: "transform" };

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("COMPONENT_BINDING_CYCLE"));
});

test("type mismatches use declared ids rather than schema similarity", async () => {
  const flow = await example("local-processing.json");
  flow.inputs.text.type = "example.other/v1";

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("TYPE_MISMATCH"));
});

test("missing component capabilities fail before execution", async () => {
  const flow = await example("site-search.json");
  flow.components.search.requires = ["pagination"];

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("MISSING_CAPABILITY"));
});

test("required component bindings fail before execution", async () => {
  const flow = await example("site-search.json");
  delete flow.components.search.bindings.browser;

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("MISSING_BINDING"));
});

test("unsupported loop syntax is rejected by FlowConfig 0.3", async () => {
  const flow = await example("local-processing.json");
  flow.nodes[0].repeat = { max: 2 };

  const result = validateFlowConfig(flow, manifests);
  assert.equal(result.ok, false);
  assert.ok(codes(result).has("SCHEMA_INVALID"));
});

test("new non-Web operation contracts need no core processing category", () => {
  const customManifest = manifest({
    id: "example.math",
    contract: "example.math/v1",
    operations: [
      {
        name: "double",
        inputs: {
          value: port("example.number/v1", {
            schema: { type: "number" }
          })
        },
        outputs: {
          value: port("example.number/v1")
        }
      }
    ]
  });

  const flow = {
    schema_version: "0.3",
    kind: "flow",
    id: "custom-math",
    inputs: {
      value: {
        type: "example.number/v1",
        value: 21
      }
    },
    components: {
      math: {
        implementation: "example.math",
        implementation_version: "0.0.0-example",
        contract: "example.math/v1",
        config: {}
      }
    },
    nodes: [
      {
        id: "double",
        component: "math",
        operation: "double",
        inputs: {
          value: {
            $ref: "flow.inputs.value"
          }
        }
      }
    ],
    execution: {
      max_parallel_nodes: 1,
      timeout_ms: 1000,
      on_node_failure: "stop"
    },
    outputs: {
      value: {
        $ref: "nodes.double.outputs.value"
      }
    }
  };

  const result = validateFlowConfig(flow, [customManifest]);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("DataRef models ownership, lifetime and committed persistence", () => {
  const valid = validateDataRef({
    schema_version: "0.1",
    kind: "data-ref",
    type: "scraping.collection/v1",
    provider: "storage",
    ref: "collection-1",
    revision: "1",
    access: {
      mode: "host-mediated"
    },
    lifetime: {
      scope: "ttl",
      expires_at: "2026-09-24T00:00:00Z"
    },
    persistence: {
      state: "committed",
      commit_ref: "commit-1"
    },
    dispose_required: false
  });
  assert.equal(valid.ok, true);

  const invalid = validateDataRef({
    schema_version: "0.1",
    kind: "data-ref",
    type: "scraping.collection/v1",
    provider: "storage",
    ref: "collection-1",
    revision: "1",
    access: {
      mode: "host-mediated"
    },
    lifetime: {
      scope: "ttl"
    },
    persistence: {
      state: "ephemeral"
    },
    dispose_required: true
  });
  assert.equal(invalid.ok, false);
});

test("common cancel and termination_unknown messages are schema-valid", () => {
  const cancel = validateOperationMessage({
    schema_version: "0.1",
    kind: "operation-cancel",
    operation_id: "op-1",
    requested_at: "2026-09-24T00:00:00Z",
    reason: "user_requested"
  });
  assert.equal(cancel.ok, true);

  const result = validateOperationMessage({
    schema_version: "0.1",
    kind: "operation-result",
    operation_id: "op-1",
    status: "termination_unknown",
    outputs: {}
  });
  assert.equal(result.ok, true);
});
