import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createExecutionPlan,
  createFlowRun
} from "../dist/index.js";

function terminal(operationId, status, outputs = {}, error) {
  return {
    schema_version: "0.1",
    kind: "operation-result",
    operation_id: operationId,
    status,
    outputs,
    ...(error === undefined ? {} : { error })
  };
}

class MockInvoker {
  constructor(handler) {
    this.handler = handler;
    this.requests = [];
    this.cancellations = [];
  }

  async invoke(request) {
    this.requests.push(request);
    return this.handler(request);
  }

  async cancel(request) {
    this.cancellations.push(request);
  }
}

async function localFlow() {
  const url = new URL(
    "../../../docs/examples/local-processing.json",
    import.meta.url
  );
  return JSON.parse(await readFile(url, "utf8"));
}

test("executes a non-Web text flow through only the abstract invoker", async () => {
  const flow = await localFlow();
  const invoker = new MockInvoker(async (request) =>
    terminal(request.operation_id, "succeeded", {
      text: String(request.inputs.text).toUpperCase()
    })
  );

  const created = createFlowRun(flow, invoker, {
    run_id: "run-text"
  });
  assert.equal(created.ok, true);

  const snapshot = await created.value.start();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.outputs.text, "OPEN SCRAPING");
  assert.equal(invoker.requests.length, 1);
  assert.equal(invoker.requests[0].operation, "transform");
});

test("rejects unsupported FlowConfig syntax before any invocation", async () => {
  const flow = await localFlow();
  flow.nodes[0].repeat = { max: 2 };

  const invoker = new MockInvoker(async (request) =>
    terminal(request.operation_id, "succeeded")
  );

  const created = createFlowRun(flow, invoker, {
    run_id: "run-invalid"
  });

  assert.equal(created.ok, false);
  assert.equal(invoker.requests.length, 0);
  assert.ok(
    created.diagnostics.some(
      (diagnostic) => diagnostic.code === "SCHEMA_INVALID"
    )
  );
});

test("continues independent work after a continue_independent failure", async () => {
  const flow = {
    schema_version: "0.3",
    kind: "flow",
    id: "independent",
    inputs: {
      value: {
        type: "example.text/v1",
        value: "ok"
      }
    },
    components: {
      custom: {
        implementation: "example.anything",
        implementation_version: "1.0.0",
        contract: "example.anything/v1",
        config: {}
      }
    },
    nodes: [
      {
        id: "fail",
        component: "custom",
        operation: "arbitrary_fail",
        inputs: {
          value: { $ref: "flow.inputs.value" }
        }
      },
      {
        id: "good1",
        component: "custom",
        operation: "arbitrary_success",
        inputs: {
          value: { $ref: "flow.inputs.value" }
        }
      },
      {
        id: "blocked",
        component: "custom",
        operation: "dependent",
        inputs: {
          value: { $ref: "nodes.fail.outputs.value" }
        }
      },
      {
        id: "good2",
        component: "custom",
        operation: "dependent",
        inputs: {
          value: { $ref: "nodes.good1.outputs.value" }
        }
      }
    ],
    execution: {
      max_parallel_nodes: 2,
      timeout_ms: 10000,
      on_node_failure: "continue_independent"
    },
    outputs: {
      good: { $ref: "nodes.good2.outputs.value" }
    }
  };

  const invoker = new MockInvoker(async (request) => {
    if (request.node_id === "fail") {
      return terminal(request.operation_id, "failed", {}, {
        code: "EXPECTED",
        message: "expected failure",
        retryable: false
      });
    }

    return terminal(request.operation_id, "succeeded", {
      value: request.inputs.value
    });
  });

  const created = createFlowRun(flow, invoker, {
    run_id: "run-independent"
  });
  assert.equal(created.ok, true);

  const snapshot = await created.value.start();

  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.nodes.fail.status, "failed");
  assert.equal(snapshot.nodes.blocked.status, "blocked");
  assert.equal(snapshot.nodes.good1.status, "succeeded");
  assert.equal(snapshot.nodes.good2.status, "succeeded");
  assert.equal(snapshot.outputs.good, "ok");
});

test("stop prevents new work and dispatches cancellation to active operations", async () => {
  const flow = await localFlow();
  flow.nodes.push({
    id: "second",
    component: "transform",
    operation: "transform",
    inputs: {
      text: { $ref: "nodes.transform.outputs.text" }
    }
  });
  flow.outputs.text = { $ref: "nodes.second.outputs.text" };

  let settle;
  const invoker = new MockInvoker(
    (request) =>
      new Promise((resolve) => {
        settle = () =>
          resolve(terminal(request.operation_id, "cancelled"));
      })
  );
  invoker.cancel = async function (request) {
    this.cancellations.push(request);
    settle?.();
  };

  const created = createFlowRun(flow, invoker, {
    run_id: "run-stop"
  });
  assert.equal(created.ok, true);

  const started = created.value.start();

  while (invoker.requests.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await created.value.stop("test_stop");
  const snapshot = await started;

  assert.equal(snapshot.status, "stopped");
  assert.equal(invoker.requests.length, 1);
  assert.equal(invoker.cancellations.length, 1);
  assert.equal(snapshot.nodes.second.status, "cancelled");
});

test("oversized inline outputs fail generically instead of entering core state", async () => {
  const flow = await localFlow();
  const invoker = new MockInvoker(async (request) =>
    terminal(request.operation_id, "succeeded", {
      text: "x".repeat(200)
    })
  );

  const created = createFlowRun(flow, invoker, {
    run_id: "run-large",
    max_inline_output_bytes: 32
  });
  assert.equal(created.ok, true);

  const snapshot = await created.value.start();

  assert.equal(snapshot.status, "stopped");
  assert.equal(snapshot.nodes.transform.status, "failed");
  assert.equal(
    snapshot.nodes.transform.error.code,
    "INLINE_OUTPUT_LIMIT_EXCEEDED"
  );
  assert.deepEqual(snapshot.outputs, {});
});

test("execution plan rejects dependency cycles", () => {
  const flow = {
    schema_version: "0.3",
    kind: "flow",
    id: "cycle",
    inputs: {},
    components: {
      custom: {
        implementation: "example.custom",
        implementation_version: "1.0.0",
        contract: "example.custom/v1",
        config: {}
      }
    },
    nodes: [
      {
        id: "a",
        component: "custom",
        operation: "one",
        inputs: {
          value: { $ref: "nodes.b.outputs.value" }
        }
      },
      {
        id: "b",
        component: "custom",
        operation: "two",
        inputs: {
          value: { $ref: "nodes.a.outputs.value" }
        }
      }
    ],
    execution: {
      max_parallel_nodes: 1,
      timeout_ms: 1000,
      on_node_failure: "stop"
    },
    outputs: {}
  };

  const result = createExecutionPlan(flow);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "NODE_CYCLE"
    )
  );
});
