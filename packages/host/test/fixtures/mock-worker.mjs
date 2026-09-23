import process from "node:process";

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

let buffer = Buffer.alloc(0);
let expected;
const mode = process.argv[2] ?? "success";
const pendingInvokes = new Map();

function send(message) {
  process.stdout.write(encode(message));
}

function handle(message) {
  if (message?.jsonrpc !== "2.0") return;

  if (message.method === "component.initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocol_version: "1",
        component_id: message.params.component_id,
        implementation_version:
          message.params.implementation_version
      }
    });
    return;
  }

  if (message.method === "component.invoke") {
    const request = message.params.request;

    if (mode === "invalid-message") {
      process.stdout.write(
        Buffer.from("Content-Length: 4\r\n\r\nnope", "ascii")
      );
      return;
    }

    if (mode === "crash-after-progress") {
      send({
        jsonrpc: "2.0",
        method: "component.progress",
        params: {
          schema_version: "0.1",
          kind: "operation-progress",
          operation_id: request.operation_id,
          sequence: 1,
          completed: 1,
          total: 2
        }
      });
      setTimeout(() => process.exit(17), 5);
      return;
    }

    if (mode === "mixed" && request.inputs.text === "hang") {
      pendingInvokes.set(request.operation_id, {
        id: message.id,
        request
      });
      return;
    }

    if (mode === "cancel-late") {
      pendingInvokes.set(request.operation_id, {
        id: message.id,
        request
      });
      return;
    }

    if (mode === "subcall") {
      pendingInvokes.set("subcall-1", {
        id: message.id,
        request
      });

      send({
        jsonrpc: "2.0",
        id: "subcall-1",
        method: "host.invoke_binding",
        params: {
          parent_operation_id: request.operation_id,
          binding: "target",
          operation: "transform",
          inputs: request.inputs,
          idempotency_key: "child"
        }
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "component.progress",
      params: {
        schema_version: "0.1",
        kind: "operation-progress",
        operation_id: request.operation_id,
        sequence: 1,
        completed: 1,
        total: 1
      }
    });

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        schema_version: "0.1",
        kind: "operation-result",
        operation_id: request.operation_id,
        status: "succeeded",
        outputs: {
          text: String(request.inputs.text).toUpperCase()
        }
      }
    });
    return;
  }

  if (message.method === "component.cancel") {
    const operationId = message.params.operation_id;

    if (mode === "mixed") {
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { accepted: true }
    });

    const pending = pendingInvokes.get(operationId);

    if (mode === "cancel-late" && pending) {
      send({
        jsonrpc: "2.0",
        id: pending.id,
        result: {
          schema_version: "0.1",
          kind: "operation-result",
          operation_id: operationId,
          status: "cancelled",
          outputs: {}
        }
      });

      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: pending.id,
          result: {
            schema_version: "0.1",
            kind: "operation-result",
            operation_id: operationId,
            status: "succeeded",
            outputs: { text: "LATE" }
          }
        });
      }, 25);
    }
    return;
  }

  if (
    message.id === "subcall-1" &&
    message.result !== undefined
  ) {
    const pending = pendingInvokes.get("subcall-1");
    if (!pending) return;

    send({
      jsonrpc: "2.0",
      id: pending.id,
      result: {
        schema_version: "0.1",
        kind: "operation-result",
        operation_id: pending.request.operation_id,
        status: "succeeded",
        outputs: message.result.outputs
      }
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    if (expected === undefined) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;

      const header = buffer.subarray(0, end).toString("ascii");
      buffer = buffer.subarray(end + 4);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) process.exit(2);
      expected = Number(match[1]);
    }

    if (buffer.length < expected) return;

    const body = buffer.subarray(0, expected);
    buffer = buffer.subarray(expected);
    expected = undefined;

    handle(JSON.parse(body.toString("utf8")));
  }
});
