import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMessageParser, encodeMessage } from "./protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worker = spawn(process.execPath, [join(here, "component.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();

const parse = createMessageParser((message) => {
  if (message.method === "component.progress") {
    process.stderr.write(
      `progress ${message.params.completed}/${message.params.total}\n`,
    );
    return;
  }

  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);

  if (message.error) {
    waiter.reject(new Error(message.error.message));
  } else {
    waiter.resolve(message.result);
  }
});

worker.stdout.on("data", parse);

function request(method, params = {}) {
  const id = nextId++;
  worker.stdin.write(
    encodeMessage({ jsonrpc: "2.0", id, method, params }),
  );

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

try {
  const initialized = await request("component.initialize", {
    protocol_version: "1",
  });
  assert.equal(initialized.component_id, "example.local-uppercase");

  const result = await request("component.invoke", {
    operation_id: "op-prototype-1",
    operation: "transform",
    inputs: { text: "open scraping" },
  });

  assert.deepEqual(result, {
    operation_id: "op-prototype-1",
    status: "succeeded",
    outputs: { text: "OPEN SCRAPING" },
  });

  await request("component.shutdown");
  worker.stdin.end();

  const exitCode = await new Promise((resolve) => {
    worker.once("exit", (code) => resolve(code));
  });

  assert.equal(exitCode, 0);
  process.stdout.write("stdio component prototype: ok\n");
} catch (error) {
  worker.kill();
  throw error;
}
