import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ComponentRegistry,
  ComponentWorkerHost
} from "../dist/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/mock-worker.mjs", import.meta.url)
);
const fixtureDir = dirname(fixturePath);

function manifest({
  id,
  contract,
  mode,
  bindings = {},
  permissions = []
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
        capabilities: [],
        operations: [
          {
            name: id.includes("parent") ? "proxy" : "transform",
            inputs: {
              text: {
                type: "example.text/v1"
              }
            },
            outputs: {
              text: {
                type: "example.text/v1"
              }
            }
          }
        ]
      }
    ],
    settings_schema: { type: "object" },
    bindings,
    permissions,
    cancellation: {
      mode: "worker_terminate",
      grace_ms: 30
    },
    runtime: {
      transport: "stdio-jsonrpc",
      command: process.execPath,
      args: [fixturePath, mode]
    }
  };
}

function register(registry, componentManifest, localName) {
  const registered = registry.register(componentManifest, {
    kind: "local-package",
    manifest_path: `/virtual/${localName}/manifest.json`,
    package_root: fixtureDir
  });
  assert.equal(
    registered.ok,
    true,
    registered.ok ? "" : JSON.stringify(registered.diagnostics)
  );
  return registered.value;
}

function snapshot(entries, bindings = {}) {
  const components = {};

  for (const [localName, registration] of Object.entries(entries)) {
    const contract = registration.manifest.contracts[0].id;
    components[localName] = {
      implementation: registration.manifest.id,
      version: registration.manifest.version,
      contract,
      manifest_sha256: registration.manifest_sha256,
      config: {},
      required_capabilities: [],
      bindings: bindings[localName] ?? {}
    };
  }

  return {
    schema_version: "0.1",
    kind: "component-binding-snapshot",
    flow_id: "host-test",
    resolved_at: "2026-09-24T00:00:00Z",
    components
  };
}

function request({
  operationId = "op-1",
  runId = "run-1",
  component = "worker",
  operation = "transform",
  text = "hello",
  key = "key-1",
  deadlineAt = "2099-01-01T00:00:00Z"
} = {}) {
  return {
    schema_version: "0.1",
    kind: "operation-request",
    operation_id: operationId,
    run_id: runId,
    node_id: "node",
    component,
    operation,
    inputs: { text },
    idempotency_key: key,
    deadline_at: deadlineAt
  };
}

async function waitFor(predicate) {
  while (!predicate()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("emits accepted, progress and final completion separately", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.success",
      contract: "example.success/v1",
      mode: "success"
    }),
    "worker"
  );

  const events = [];
  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ worker }),
    {
      run_id: "run-1",
      on_event: (event) => events.push(event)
    }
  );

  const final = await invoker.invoke(request());

  assert.equal(final.status, "succeeded");
  assert.equal(final.outputs.text, "HELLO");
  assert.deepEqual(
    events
      .filter((event) => event.type !== "diagnostic")
      .map((event) => event.type),
    ["accepted", "progress", "completed"]
  );

  await invoker.shutdown();
});

test("deduplicates identical idempotency keys and rejects content conflicts", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.idempotent",
      contract: "example.idempotent/v1",
      mode: "success"
    }),
    "worker"
  );

  const events = [];
  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ worker }),
    {
      run_id: "run-1",
      on_event: (event) => events.push(event)
    }
  );

  const original = request();
  const first = await invoker.invoke(original);
  const second = await invoker.invoke({
    ...original,
    operation_id: "op-retry"
  });

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(
    events.filter((event) => event.type === "accepted").length,
    1
  );

  const conflict = await invoker.invoke({
    ...original,
    operation_id: "op-conflict",
    inputs: { text: "different" }
  });

  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");

  await invoker.shutdown();
});

test("force-terminates only the owned operation worker after cancel grace", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.mixed",
      contract: "example.mixed/v1",
      mode: "mixed"
    }),
    "worker"
  );

  const host = new ComponentWorkerHost(registry, {
    default_cancel_grace_ms: 20
  });

  const run1Events = [];
  const run1 = host.createRunInvoker(snapshot({ worker }), {
    run_id: "run-1",
    on_event: (event) => run1Events.push(event)
  });
  const run2 = host.createRunInvoker(snapshot({ worker }), {
    run_id: "run-2"
  });

  const hanging = run1.invoke(
    request({
      operationId: "op-hang",
      runId: "run-1",
      text: "hang",
      key: "hang"
    })
  );

  await waitFor(() =>
    run1Events.some((event) => event.type === "accepted")
  );

  const other = await run2.invoke(
    request({
      operationId: "op-ok",
      runId: "run-2",
      text: "safe",
      key: "safe"
    })
  );
  assert.equal(other.status, "succeeded");
  assert.equal(other.outputs.text, "SAFE");

  await run1.cancel({
    schema_version: "0.1",
    kind: "operation-cancel",
    operation_id: "op-hang",
    requested_at: new Date().toISOString(),
    reason: "test"
  });

  const stopped = await hanging;
  assert.equal(stopped.status, "termination_unknown");

  await run1.shutdown();
  await run2.shutdown();
});

test("progress followed by worker crash becomes termination_unknown", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.crash",
      contract: "example.crash/v1",
      mode: "crash-after-progress"
    }),
    "worker"
  );

  const events = [];
  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ worker }),
    {
      run_id: "run-1",
      on_event: (event) => events.push(event)
    }
  );

  const final = await invoker.invoke(request());

  assert.equal(final.status, "termination_unknown");
  assert.ok(events.some((event) => event.type === "progress"));

  await invoker.shutdown();
});

test("invalid worker messages do not crash the host", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.invalid",
      contract: "example.invalid/v1",
      mode: "invalid-message"
    }),
    "worker"
  );

  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ worker }),
    { run_id: "run-1" }
  );

  const final = await invoker.invoke(request());

  assert.equal(final.status, "termination_unknown");

  await invoker.shutdown();
});

test("late response after cancellation cannot overwrite the terminal result", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.cancel",
      contract: "example.cancel/v1",
      mode: "cancel-late"
    }),
    "worker"
  );

  const events = [];
  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ worker }),
    {
      run_id: "run-1",
      on_event: (event) => events.push(event)
    }
  );

  const pending = invoker.invoke(request());
  await waitFor(() =>
    events.some((event) => event.type === "accepted")
  );

  await invoker.cancel({
    schema_version: "0.1",
    kind: "operation-cancel",
    operation_id: "op-1",
    requested_at: new Date().toISOString(),
    reason: "test"
  });

  const final = await pending;
  assert.equal(final.status, "cancelled");

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(
    events
      .filter((event) => event.type === "completed")
      .map((event) => event.result.status),
    ["cancelled"]
  );

  await invoker.shutdown();
});

test("permissions are denied unless the host explicitly grants them", async () => {
  const registry = new ComponentRegistry();
  const worker = register(
    registry,
    manifest({
      id: "example.permission",
      contract: "example.permission/v1",
      mode: "success",
      permissions: ["network"]
    }),
    "worker"
  );

  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ worker }),
    { run_id: "run-1" }
  );

  const final = await invoker.invoke(request());

  assert.equal(final.status, "failed");
  assert.equal(final.error.code, "PERMISSION_DENIED");

  await invoker.shutdown();
});

test("binding subcalls inherit run, deadline, cancellation and budget scope", async () => {
  const registry = new ComponentRegistry();
  const target = register(
    registry,
    manifest({
      id: "example.target",
      contract: "example.target/v1",
      mode: "success"
    }),
    "target"
  );
  const parent = register(
    registry,
    manifest({
      id: "example.parent",
      contract: "example.parent/v1",
      mode: "subcall",
      bindings: {
        target: {
          contract: "example.target/v1"
        }
      }
    }),
    "parent"
  );

  const events = [];
  const bindings = {
    parent: {
      target: {
        local_name: "target",
        implementation: "example.target",
        version: "1.0.0",
        contract: "example.target/v1"
      }
    }
  };

  const invoker = new ComponentWorkerHost(registry).createRunInvoker(
    snapshot({ parent, target }, bindings),
    {
      run_id: "run-sub",
      budget_scope_id: "budget-run-sub",
      on_event: (event) => events.push(event)
    }
  );

  const deadline = "2099-01-01T00:00:00Z";
  const final = await invoker.invoke(
    request({
      operationId: "op-parent",
      runId: "run-sub",
      component: "parent",
      operation: "proxy",
      text: "nested",
      key: "parent",
      deadlineAt: deadline
    })
  );

  assert.equal(final.status, "succeeded");
  assert.equal(final.outputs.text, "NESTED");

  const accepted = events.filter(
    (event) => event.type === "accepted"
  );
  assert.equal(accepted.length, 2);

  const child = accepted.find(
    (event) => event.request.component === "target"
  );
  assert.ok(child);
  assert.equal(child.request.run_id, "run-sub");
  assert.equal(child.request.deadline_at, deadline);
  assert.equal(
    child.scope.cancellation_scope_id,
    "op-parent"
  );
  assert.equal(
    child.scope.budget_scope_id,
    "budget-run-sub"
  );
  assert.equal(
    child.scope.parent_operation_id,
    "op-parent"
  );

  await invoker.shutdown();
});
