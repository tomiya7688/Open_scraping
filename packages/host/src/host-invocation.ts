import { createHash } from "node:crypto";
import type { OperationRequest, OperationResult } from "@open-scraping/contracts";
import type { BindingInvocationParams } from "./host-types.js";

// Stateless idempotency, result, binding-input and timeout helpers.
export class HostInvocationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    retryable = false
  ) {
    super(message);
    this.name = "HostInvocationError";
    this.code = code;
    this.retryable = retryable;
  }
}
export function asRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;

  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )
    .join(",")}}`;
}

export function requestContentHash(request: OperationRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        run_id: request.run_id,
        node_id: request.node_id,
        component: request.component,
        operation: request.operation,
        inputs: request.inputs,
        deadline_at: request.deadline_at
      }),
      "utf8"
    )
    .digest("hex");
}

export function result(
  request: OperationRequest,
  status: OperationResult["status"],
  code?: string,
  message?: string,
  retryable = false
): OperationResult {
  return {
    schema_version: "0.1",
    kind: "operation-result",
    operation_id: request.operation_id,
    status,
    outputs: {},
    ...(code === undefined
      ? {}
      : {
          error: {
            code,
            message: message ?? code,
            retryable
          }
        })
  };
}
export function terminalStatus(
  status: OperationResult["status"]
): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "termination_unknown"
  );
}

export function parseBindingInvocation(
  value: unknown
): BindingInvocationParams {
  const record = asRecord(value);

  if (
    !record ||
    typeof record.parent_operation_id !== "string" ||
    typeof record.binding !== "string" ||
    typeof record.operation !== "string" ||
    !asRecord(record.inputs)
  ) {
    throw new HostInvocationError(
      "INVALID_BINDING_INVOCATION",
      "host.invoke_binding params are invalid"
    );
  }

  return {
    parent_operation_id: record.parent_operation_id,
    binding: record.binding,
    operation: record.operation,
    inputs: record.inputs as Record<string, unknown>,
    ...(typeof record.idempotency_key === "string"
      ? { idempotency_key: record.idempotency_key }
      : {})
  };
}
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HostInvocationError(
                "WORKER_INITIALIZE_TIMEOUT",
                message,
                true
              )
            ),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
