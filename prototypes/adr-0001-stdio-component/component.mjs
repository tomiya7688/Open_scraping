import { createMessageParser, encodeMessage } from "./protocol.mjs";

function send(message) {
  process.stdout.write(encodeMessage(message));
}

const parse = createMessageParser((message) => {
  if (message?.jsonrpc !== "2.0") {
    return;
  }

  if (message.method === "component.initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocol_version: "1",
        component_id: "example.local-uppercase",
        implementation_version: "0.0.1-prototype",
      },
    });
    return;
  }

  if (message.method === "component.invoke") {
    const operation = message.params?.operation;
    const text = message.params?.inputs?.text;

    if (operation !== "transform" || typeof text !== "string") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: "Expected transform operation with a string text input",
        },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "component.progress",
      params: {
        operation_id: message.params.operation_id,
        completed: 1,
        total: 1,
      },
    });

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        operation_id: message.params.operation_id,
        status: "succeeded",
        outputs: {
          text: text.toUpperCase(),
        },
      },
    });
    return;
  }

  if (message.method === "component.shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: { accepted: true } });
    process.exitCode = 0;
    return;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
});

process.stdin.on("data", parse);
process.stdin.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
