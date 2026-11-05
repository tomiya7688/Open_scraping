import process from "node:process";
import { assessTextOrigin } from "./assess.mjs";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
let buffer = Buffer.alloc(0);
let expectedBytes;

function respond(message) {
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([
    Buffer.from("Content-Length: " + bytes.length + "\r\n\r\n", "ascii"),
    bytes
  ]));
}

function errorResponse(id, code, message) {
  respond({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (!message || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string") {
    errorResponse(message?.id ?? null, -32600, "Invalid JSON-RPC request");
    return;
  }

  if (message.method === "component.initialize") {
    if (message.params?.protocol_version !== "1" ||
        message.params?.component_id !== "open-scraping.ai-text-origin-filter" ||
        message.params?.implementation_version !== "0.1.0") {
      errorResponse(message.id, -32602, "Component initialization mismatch");
      return;
    }
    respond({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocol_version: "1",
        component_id: "open-scraping.ai-text-origin-filter",
        implementation_version: "0.1.0"
      }
    });
    return;
  }

  if (message.method === "component.cancel") {
    respond({ jsonrpc: "2.0", id: message.id, result: { accepted: true } });
    return;
  }

  if (message.method === "component.invoke") {
    const request = message.params?.request;
    if (!request || typeof request.operation_id !== "string") {
      errorResponse(message.id, -32602, "Invalid operation request");
      return;
    }
    let result;
    if (request.operation !== "assess" ||
        request.component === undefined) {
      result = {
        schema_version: "0.1",
        kind: "operation-result",
        operation_id: request.operation_id,
        status: "failed",
        outputs: {},
        error: { code: "UNSUPPORTED_OPERATION", message: "Operation is not supported", retryable: false }
      };
    } else {
      try {
        const assessment = assessTextOrigin(request.inputs);
        result = {
          schema_version: "0.1",
          kind: "operation-result",
          operation_id: request.operation_id,
          status: "succeeded",
          outputs: { assessment }
        };
      } catch {
        // Never send the input text, metadata, stack or credentials to the host error log.
        result = {
          schema_version: "0.1",
          kind: "operation-result",
          operation_id: request.operation_id,
          status: "failed",
          outputs: {},
          error: { code: "INVALID_ORIGIN_INPUT", message: "Origin assessment input is invalid", retryable: false }
        };
      }
    }
    respond({ jsonrpc: "2.0", id: message.id, result });
    return;
  }

  if (message.id !== undefined) {
    errorResponse(message.id, -32601, "Unknown method");
  }
}

function badFrame() {
  // Exit the worker without echoing untrusted input or returning a partial result.
  process.exit(2);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES) badFrame();

  while (true) {
    if (expectedBytes === undefined) {
      const split = buffer.indexOf("\r\n\r\n");
      if (split === -1) {
        if (buffer.length > MAX_HEADER_BYTES) badFrame();
        return;
      }
      if (split > MAX_HEADER_BYTES) badFrame();
      const header = buffer.subarray(0, split).toString("ascii");
      buffer = buffer.subarray(split + 4);
      // The Host sends Content-Length plus Content-Type on separate lines.
      // Parse header fields, not the whole multi-line header as one value.
      const headers = header.split("\r\n");
      const lengths = headers
        .filter((line) => /^Content-Length:/i.test(line))
        .map((line) => /^Content-Length:\s*(\d+)\s*$/i.exec(line));
      if (lengths.length !== 1 || !lengths[0]) badFrame();
      expectedBytes = Number(lengths[0][1]);
      if (!Number.isSafeInteger(expectedBytes) ||
          expectedBytes < 1 || expectedBytes > MAX_FRAME_BYTES) badFrame();
    }
    if (buffer.length < expectedBytes) return;

    const frame = buffer.subarray(0, expectedBytes);
    buffer = buffer.subarray(expectedBytes);
    expectedBytes = undefined;

    try {
      handle(JSON.parse(frame.toString("utf8")));
    } catch {
      errorResponse(null, -32700, "Invalid JSON");
    }
  }
});
