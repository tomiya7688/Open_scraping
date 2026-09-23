import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ComponentRegistry } from "../dist/index.js";

function manifest({
  id,
  contract,
  operations,
  bindings = {},
  capabilities = [],
  settingsSchema = { type: "object" }
}) {
  return {
    schema_version: "0.1",
    kind: "component-manifest",
    id,
    version: "1.0.0",
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
    settings_schema: settingsSchema,
    bindings,
    permissions: [],
    cancellation: {
      mode: "cooperative"
    },
    runtime: {
      transport: "stdio-jsonrpc",
      command: "worker"
    }
  };
}

const mathManifest = manifest({
  id: "example.math",
  contract: "example.math/v1",
  operations: [
    {
      name: "double",
      inputs: {
        value: {
          type: "example.number/v1",
          schema: { type: "number" }
        }
      },
      outputs: {
        value: {
          type: "example.number/v1"
        }
      }
    }
  ]
});

const sourceManifest = manifest({
  id: "example.source",
  contract: "example.source/v1",
  capabilities: ["read"],
  operations: [
    {
      name: "read",
      inputs: {},
      outputs: {
        value: {
          type: "example.number/v1"
        }
      }
    }
  ]
});

const consumerManifest = manifest({
  id: "example.consumer",
  contract: "example.consumer/v1",
  bindings: {
    source: {
      contract: "example.source/v1",
      capabilities: ["read"]
    }
  },
  operations: [
    {
      name: "consume",
      inputs: {
        value: {
          type: "example.number/v1"
        }
      },
      outputs: {
        value: {
          type: "example.number/v1"
        }
      }
    }
  ]
});

function source(id = "test") {
  return {
    kind: "local-package",
    manifest_path: `/components/${id}/manifest.json`
  };
}

test("registers and lists arbitrary non-Web contracts", () => {
  const registry = new ComponentRegistry();
  const registered = registry.register(mathManifest, source("math"));

  assert.equal(registered.ok, true);
  assert.equal(registry.list().length, 1);
  assert.equal(
    registry.list()[0].manifest.contracts[0].id,
    "example.math/v1"
  );
});

test("invalid settings JSON Schema is rejected at registration", () => {
  const registry = new ComponentRegistry();
  const invalid = manifest({
    id: "example.invalid",
    contract: "example.invalid/v1",
    settingsSchema: {
      type: "not-a-json-schema-type"
    },
    operations: [
      {
        name: "run",
        inputs: {},
        outputs: {}
      }
    ]
  });

  const result = registry.register(invalid, source("invalid"));
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "MANIFEST_SCHEMA_INVALID"
    )
  );
});

test("duplicate implementation+version never silently replaces a manifest", () => {
  const registry = new ComponentRegistry();
  assert.equal(registry.register(mathManifest, source("math")).ok, true);

  const changed = JSON.parse(JSON.stringify(mathManifest));
  changed.permissions = ["network"];

  const result = registry.register(changed, source("math-other"));
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "COMPONENT_ALREADY_REGISTERED"
    )
  );
});

test("availability reports candidates but does not create a binding", () => {
  const registry = new ComponentRegistry();
  registry.register(consumerManifest, source("consumer"));

  const before = registry.getAvailability("example.consumer", "1.0.0");
  assert.equal(before.ok, true);
  assert.equal(before.value.ready, false);
  assert.deepEqual(before.value.bindings[0].candidates, []);

  registry.register(sourceManifest, source("source"));

  const after = registry.getAvailability("example.consumer", "1.0.0");
  assert.equal(after.ok, true);
  assert.equal(after.value.ready, true);
  assert.deepEqual(after.value.bindings[0].candidates, [
    {
      implementation: "example.source",
      version: "1.0.0",
      contract: "example.source/v1"
    }
  ]);
});

test("flow resolution pins implementation, version, config and explicit binding", () => {
  const registry = new ComponentRegistry();
  registry.register(sourceManifest, source("source"));
  registry.register(consumerManifest, source("consumer"));

  const flow = {
    schema_version: "0.3",
    kind: "flow",
    id: "binding-test",
    inputs: {},
    components: {
      source: {
        implementation: "example.source",
        implementation_version: "1.0.0",
        contract: "example.source/v1",
        config: {
          location: "local"
        }
      },
      consumer: {
        implementation: "example.consumer",
        implementation_version: "1.0.0",
        contract: "example.consumer/v1",
        config: {
          mode: "strict"
        },
        bindings: {
          source: "source"
        }
      }
    },
    nodes: [
      {
        id: "read",
        component: "source",
        operation: "read",
        inputs: {}
      },
      {
        id: "consume",
        component: "consumer",
        operation: "consume",
        inputs: {
          value: {
            $ref: "nodes.read.outputs.value"
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
        $ref: "nodes.consume.outputs.value"
      }
    }
  };

  const resolved = registry.resolveFlowBindings(
    flow,
    "2026-09-24T00:00:00Z"
  );

  assert.equal(
    resolved.ok,
    true,
    resolved.ok ? "" : JSON.stringify(resolved.diagnostics)
  );

  assert.equal(
    resolved.value.components.consumer.version,
    "1.0.0"
  );
  assert.deepEqual(
    resolved.value.components.consumer.config,
    { mode: "strict" }
  );
  assert.deepEqual(
    resolved.value.components.consumer.bindings.source,
    {
      local_name: "source",
      implementation: "example.source",
      version: "1.0.0",
      contract: "example.source/v1"
    }
  );
  assert.match(
    resolved.value.components.consumer.manifest_sha256,
    /^[a-f0-9]{64}$/
  );
});

test("a missing requested implementation is not replaced by another provider", () => {
  const registry = new ComponentRegistry();
  registry.register(sourceManifest, source("source"));

  const alternate = manifest({
    id: "example.alternate-source",
    contract: "example.source/v1",
    capabilities: ["read"],
    operations: sourceManifest.contracts[0].operations
  });
  registry.register(alternate, source("alternate"));

  const flow = {
    schema_version: "0.3",
    kind: "flow",
    id: "no-fallback",
    inputs: {},
    components: {
      source: {
        implementation: "example.not-installed",
        implementation_version: "1.0.0",
        contract: "example.source/v1",
        config: {}
      }
    },
    nodes: [
      {
        id: "read",
        component: "source",
        operation: "read",
        inputs: {}
      }
    ],
    execution: {
      max_parallel_nodes: 1,
      timeout_ms: 1000,
      on_node_failure: "stop"
    },
    outputs: {
      value: {
        $ref: "nodes.read.outputs.value"
      }
    }
  };

  const resolved = registry.resolveFlowBindings(flow);
  assert.equal(resolved.ok, false);
  assert.ok(
    resolved.diagnostics.some(
      (diagnostic) => diagnostic.code === "MANIFEST_NOT_FOUND"
    )
  );
});

test("active run usage blocks removal and reports every affected run", () => {
  const registry = new ComponentRegistry();
  registry.register(mathManifest, source("math"));

  const flow = {
    schema_version: "0.3",
    kind: "flow",
    id: "usage-test",
    inputs: {
      value: {
        type: "example.number/v1",
        value: 2
      }
    },
    components: {
      math: {
        implementation: "example.math",
        implementation_version: "1.0.0",
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

  const resolved = registry.resolveFlowBindings(flow);
  assert.equal(resolved.ok, true);

  registry.markRunUsage("run-b", resolved.value);
  registry.markRunUsage("run-a", resolved.value);

  assert.deepEqual(
    registry.remove("example.math", "1.0.0"),
    {
      removed: false,
      reason: "in_use",
      blocked_by_runs: ["run-a", "run-b"]
    }
  );

  registry.releaseRun("run-a");
  registry.releaseRun("run-b");

  assert.deepEqual(
    registry.remove("example.math", "1.0.0"),
    {
      removed: true,
      reason: "removed",
      blocked_by_runs: []
    }
  );
});

test("registerFromFile reads a local package manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "open-scraping-registry-"));
  const path = join(directory, "manifest.json");

  try {
    await writeFile(path, JSON.stringify(mathManifest), "utf8");

    const registry = new ComponentRegistry();
    const result = await registry.registerFromFile(path, directory);

    assert.equal(result.ok, true);
    assert.equal(result.value.source.manifest_path, path);
    assert.equal(result.value.source.package_root, directory);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true
    });
  }
});
