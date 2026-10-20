import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { ComponentRegistry, startLoopbackApi } from "../dist/index.js";

const token = "test-only-" + "s".repeat(50);

function manifest() {
  return {
    schema_version: "0.1",
    kind: "component-manifest",
    id: "example.transform",
    version: "1.0.0",
    protocol: { name: "open-scraping.component-rpc", version: "1" },
    contracts: [{
      id: "example.transform/v1",
      capabilities: [],
      operations: [{
        name: "transform",
        inputs: { text: { type: "example.text/v1" } },
        outputs: { text: { type: "example.text/v1" } }
      }]
    }],
    settings_schema: { type: "object" },
    permissions: [],
    cancellation: { mode: "cooperative" },
    runtime: { transport: "stdio-jsonrpc", command: "mock" }
  };
}

function flow(id = "example-flow") {
  return {
    schema_version: "0.3",
    kind: "flow",
    id,
    inputs: { text: { type: "example.text/v1", value: "hello" } },
    components: {
      transform: {
        implementation: "example.transform",
        implementation_version: "1.0.0",
        contract: "example.transform/v1",
        config: {}
      }
    },
    nodes: [{
      id: "first",
      component: "transform",
      operation: "transform",
      inputs: { text: { $ref: "flow.inputs.text" } }
    }],
    execution: {
      max_parallel_nodes: 1,
      timeout_ms: 10000,
      on_node_failure: "stop"
    },
    outputs: { text: { $ref: "nodes.first.outputs.text" } }
  };
}

async function withServer(run, overrides = {}) {
  const registry = new ComponentRegistry();
  const registration = registry.register(manifest(), {
    kind: "local-package",
    manifest_path: "/virtual/mock.json"
  });
  assert.equal(registration.ok, true, JSON.stringify(registration.diagnostics));

  const server = await startLoopbackApi({
    registry,
    token,
    allowed_origins: ["http://localhost:5173"],
    ...overrides
  });

  try {
    await run(server.base_url);
  } finally {
    await server.close();
  }
}

function request(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    }
  });
}

function body(value) {
  return JSON.stringify(value);
}

test("only serves loopback with bearer auth, exact Host and explicit Origin", async () => {
  await assert.rejects(
    () => startLoopbackApi({ registry: new ComponentRegistry(), token: "short" }),
    /at least 32/
  );

  await withServer(async (base) => {
    assert.ok(base.startsWith("http://127.0.0.1:"));

    const unauthenticated = await fetch(base + "/api/v0/components");
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("www-authenticate"), "Bearer");

    const badToken = await request(base, "/api/v0/components", {
      headers: { Authorization: "Bearer bad-token" }
    });
    assert.equal(badToken.status, 401);
    assert.doesNotMatch(await badToken.text(), /bad-token|test-only/);

    const deniedOrigin = await request(base, "/api/v0/components", {
      headers: { Origin: "http://other.localhost:5173" }
    });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(deniedOrigin.headers.get("access-control-allow-origin"), null);

    const allowedOrigin = await request(base, "/api/v0/components", {
      headers: { Origin: "http://localhost:5173" }
    });
    assert.equal(allowedOrigin.status, 200);
    assert.equal(allowedOrigin.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const preflight = await fetch(base + "/api/v0/flows", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type"
      }
    });
    assert.equal(preflight.status, 204);

    // Fetch may overwrite Host with the URL authority; use raw node:http
    // to verify the server actually rejects a forged Host header.
    const badHostStatus = await new Promise((resolve, reject) => {
      const address = new URL(base);
      const raw = httpRequest({
        hostname: address.hostname,
        port: Number(address.port),
        path: "/api/v0/components",
        method: "GET",
        headers: {
          Host: "attacker.invalid",
          Authorization: "Bearer " + token
        }
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      raw.on("error", reject);
      raw.end();
    });
    assert.equal(badHostStatus, 400);
  });
});

test("validates flows against registered component contracts", async () => {
  await withServer(async (base) => {
    const valid = await request(base, "/api/v0/flows/validate", {
      method: "POST",
      body: body(flow())
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { valid: true, diagnostics: [] });

    const invalidFlow = flow();
    invalidFlow.nodes[0].operation = "not-implemented";
    const invalid = await request(base, "/api/v0/flows/validate", {
      method: "POST",
      body: body(invalidFlow)
    });
    assert.equal(invalid.status, 200);
    const diagnostic = await invalid.json();
    assert.equal(diagnostic.valid, false);
    assert.ok(diagnostic.diagnostics.some((d) => d.code === "OPERATION_NOT_PROVIDED"));
  });
});

test("registers flows, serves immutable copies and enforces optimistic revisions", async () => {
  await withServer(async (base) => {
    const first = await request(base, "/api/v0/flows", {
      method: "POST",
      body: body(flow())
    });
    assert.equal(first.status, 201);
    const entry = await first.json();
    assert.equal(entry.flow.id, "example-flow");
    assert.equal(entry.revision.length, 64);
    assert.equal(first.headers.get("etag"), '"' + entry.revision + '"');
    assert.equal(first.headers.get("location"), "/api/v0/flows/example-flow");

    const again = await request(base, "/api/v0/flows", {
      method: "POST",
      body: body(flow())
    });
    assert.equal(again.status, 409);

    const read = await request(base, "/api/v0/flows/example-flow");
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), entry);

    const missingPrecondition = await request(base, "/api/v0/flows/example-flow", {
      method: "PATCH",
      body: body(flow())
    });
    assert.equal(missingPrecondition.status, 428);

    const changed = flow();
    changed.inputs.text.value = "updated";
    const badRevision = await request(base, "/api/v0/flows/example-flow", {
      method: "PATCH",
      headers: { "If-Match": '"' + "0".repeat(64) + '"' },
      body: body(changed)
    });
    assert.equal(badRevision.status, 412);

    const wrongId = await request(base, "/api/v0/flows/example-flow", {
      method: "PATCH",
      headers: { "If-Match": '"' + entry.revision + '"' },
      body: body(flow("renamed-flow"))
    });
    assert.equal(wrongId.status, 422);

    const updated = await request(base, "/api/v0/flows/example-flow", {
      method: "PATCH",
      headers: { "If-Match": '"' + entry.revision + '"' },
      body: body(changed)
    });
    assert.equal(updated.status, 200);
    const updatedEntry = await updated.json();
    assert.notEqual(updatedEntry.revision, entry.revision);
    assert.equal(updatedEntry.flow.inputs.text.value, "updated");

    const previousRevision = await request(base, "/api/v0/flows/example-flow", {
      method: "PATCH",
      headers: { "If-Match": '"' + entry.revision + '"' },
      body: body(changed)
    });
    assert.equal(previousRevision.status, 412);

    const fresh = await request(base, "/api/v0/flows/example-flow");
    assert.equal((await fresh.json()).flow.inputs.text.value, "updated");
  });
});

test("component reads require an explicitly pinned manifest version", async () => {
  await withServer(async (base) => {
    const list = await request(base, "/api/v0/components");
    assert.equal(list.status, 200);
    const { components } = await list.json();
    assert.equal(components.length, 1);
    assert.equal(components[0].id, "example.transform");

    const noVersion = await request(base, "/api/v0/components/example.transform/manifest");
    assert.equal(noVersion.status, 400);

    const manifestResponse = await request(
      base, "/api/v0/components/example.transform/manifest?version=1.0.0"
    );
    assert.equal(manifestResponse.status, 200);
    const details = await manifestResponse.json();
    assert.equal(details.manifest.id, "example.transform");

    const unknown = await request(
      base, "/api/v0/components/example.transform/manifest?version=5.0.0"
    );
    assert.equal(unknown.status, 404);
  });
});

test("rejects malformed or oversized JSON, and never fakes an unfinished run", async () => {
  await withServer(async (base) => {
    const wrongType = await request(base, "/api/v0/flows", {
      method: "POST",
      body: body(flow()),
      headers: { "Content-Type": "text/plain" }
    });
    assert.equal(wrongType.status, 415);

    const invalidJson = await request(base, "/api/v0/flows", {
      method: "POST",
      body: "{broken"
    });
    assert.equal(invalidJson.status, 400);

    const tooLarge = await request(base, "/api/v0/flows", {
      method: "POST",
      body: body(flow())
    });
    assert.equal(tooLarge.status, 413);

    const futureRun = await request(base, "/api/v0/runs", {
      method: "POST",
      body: body({ flow_id: "example-flow" })
    });
    assert.equal(futureRun.status, 501);
    assert.equal((await futureRun.json()).error.code, "NOT_IMPLEMENTED");

    const futureInvoke = await request(
      base, "/api/v0/components/example.transform/invoke", {
        method: "POST",
        body: body({ operation: "transform" })
      }
    );
    assert.equal(futureInvoke.status, 501);
  }, { max_body_bytes: 96 });
});

test("OpenAPI describes the implemented routes and their primary responses", async () => {
  const spec = JSON.parse(await readFile(
    new URL("../openapi-v0-foundation.json", import.meta.url),
    "utf8"
  ));
  assert.equal(spec.openapi, "3.1.0");
  const required = [
    ["/api/v0/flows/validate", "post", "200"],
    ["/api/v0/flows", "post", "201"],
    ["/api/v0/flows/{id}", "get", "200"],
    ["/api/v0/flows/{id}", "patch", "200"],
    ["/api/v0/components", "get", "200"],
    ["/api/v0/components/{id}/manifest", "get", "200"]
  ];

  for (const [path, method, status] of required) {
    assert.ok(spec.paths[path]?.[method]?.responses[status], path + " " + method);
    assert.deepEqual(spec.paths[path][method].security, [{ bearerAuth: [] }]);
  }
  assert.equal(spec.paths["/api/v0/runs"], undefined);
});
