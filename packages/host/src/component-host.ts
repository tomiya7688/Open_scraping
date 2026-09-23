import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import {
  validateOperationMessage
} from "@open-scraping/contracts";
import type {
  ComponentManifest,
  OperationCancel,
  OperationProgress,
  OperationRequest,
  OperationResult
} from "@open-scraping/contracts";
import type {
  FlowInvoker
} from "@open-scraping/core";

import type {
  ComponentBindingSnapshot,
  ComponentRegistry,
  ResolvedComponentSnapshot
} from "./registry.js";
import {
  JsonRpcPeer,
  ProtocolError,
  WorkerExitedError
} from "./protocol.js";

export interface PermissionRequest {
  run_id: string;
  component_local_name: string;
  implementation: string;
  version: string;
  requested_permissions: string[];
}

export interface PermissionDecision {
  allowed: boolean;
  opaque_grants?: Record<string, string>;
}

export type PermissionResolver = (
  request: PermissionRequest
) => PermissionDecision | Promise<PermissionDecision>;

export interface OperationScope {
  cancellation_scope_id: string;
  budget_scope_id: string;
  parent_operation_id?: string;
}

export type HostOperationEvent =
  | {
      type: "accepted";
      request: OperationRequest;
      result: OperationResult;
      scope: OperationScope;
    }
  | {
      type: "progress";
      request: OperationRequest;
      progress: OperationProgress;
      scope: OperationScope;
    }
  | {
      type: "completed";
      request: OperationRequest;
      result: OperationResult;
      scope: OperationScope;
    }
  | {
      type: "diagnostic";
      operation_id?: string;
      component?: string;
      code: string;
      message: string;
    };

export interface ComponentWorkerHostOptions {
  max_frame_bytes?: number;
  initialize_timeout_ms?: number;
  default_cancel_grace_ms?: number;
  permission_resolver?: PermissionResolver;
}

export interface RunInvokerOptions {
  run_id: string;
  budget_scope_id?: string;
  on_event?: (event: HostOperationEvent) => void;
}

class HostInvocationError extends Error {
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

interface WorkerSession {
  peer: JsonRpcPeer;
  manifest: ComponentManifest;
  grants: Record<string, string>;
  grace_ms: number;
}

interface ActiveOperation {
  request: OperationRequest;
  scope: OperationScope;
  session: WorkerSession;
  last_progress_sequence: number;
  deadline_timer?: ReturnType<typeof setTimeout>;
  force_timer?: ReturnType<typeof setTimeout>;
  cancel_requested: boolean;
}

interface IdempotencyRecord {
  content_hash: string;
  promise: Promise<OperationResult>;
}

interface BindingInvocationParams {
  parent_operation_id: string;
  binding: string;
  operation: string;
  inputs: Record<string, unknown>;
  idempotency_key?: string;
}

function asRecord(
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

function requestContentHash(request: OperationRequest): string {
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

function result(
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

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP"
  ];

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

function terminalStatus(
  status: OperationResult["status"]
): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "termination_unknown"
  );
}

function parseBindingInvocation(
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

async function withTimeout<T>(
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

export class ComponentWorkerHost {
  readonly #registry: ComponentRegistry;
  readonly #options: ComponentWorkerHostOptions;

  constructor(
    registry: ComponentRegistry,
    options: ComponentWorkerHostOptions = {}
  ) {
    this.#registry = registry;
    this.#options = options;
  }

  createRunInvoker(
    snapshot: ComponentBindingSnapshot,
    options: RunInvokerOptions
  ): RunComponentInvoker {
    return new RunComponentInvoker(
      this.#registry,
      snapshot,
      options,
      this.#options
    );
  }
}

export class RunComponentInvoker implements FlowInvoker {
  readonly #registry: ComponentRegistry;
  readonly #snapshot: ComponentBindingSnapshot;
  readonly #runId: string;
  readonly #budgetScopeId: string;
  readonly #onEvent: ((event: HostOperationEvent) => void) | undefined;
  readonly #hostOptions: ComponentWorkerHostOptions;
  readonly #active = new Map<string, ActiveOperation>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  #subcallCounter = 0;
  #closed = false;

  constructor(
    registry: ComponentRegistry,
    snapshot: ComponentBindingSnapshot,
    runOptions: RunInvokerOptions,
    hostOptions: ComponentWorkerHostOptions
  ) {
    this.#registry = registry;
    this.#snapshot = snapshot;
    this.#runId = runOptions.run_id;
    this.#budgetScopeId =
      runOptions.budget_scope_id ?? runOptions.run_id;
    this.#onEvent = runOptions.on_event;
    this.#hostOptions = hostOptions;
  }

  invoke(request: OperationRequest): Promise<OperationResult> {
    const scope: OperationScope = {
      cancellation_scope_id: request.operation_id,
      budget_scope_id: this.#budgetScopeId
    };

    return this.#invokeInternal(request, scope);
  }

  async cancel(request: OperationCancel): Promise<void> {
    const validation = validateOperationMessage(request);
    if (!validation.ok) {
      throw new HostInvocationError(
        "INVALID_CANCEL_REQUEST",
        validation.diagnostics[0]?.message ??
          "Cancellation message is invalid"
      );
    }

    const target = this.#active.get(request.operation_id);
    if (!target) return;

    const scopeId = target.scope.cancellation_scope_id;

    for (const active of this.#active.values()) {
      if (active.scope.cancellation_scope_id === scopeId) {
        this.#dispatchCancel(
          active,
          request.reason ?? "cancel_requested"
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const active of this.#active.values()) {
      active.session.peer.terminate(
        new HostInvocationError(
          "HOST_SHUTDOWN",
          "Run component host was shut down",
          true
        )
      );
    }

    await Promise.allSettled(
      [...this.#idempotency.values()].map(
        (record) => record.promise
      )
    );
  }

  #invokeInternal(
    request: OperationRequest,
    scope: OperationScope
  ): Promise<OperationResult> {
    if (this.#closed) {
      return Promise.resolve(
        result(
          request,
          "failed",
          "HOST_CLOSED",
          "Run component host is closed"
        )
      );
    }

    const validation = validateOperationMessage(request);
    if (!validation.ok) {
      return Promise.resolve(
        result(
          request,
          "failed",
          "INVALID_OPERATION_REQUEST",
          validation.diagnostics[0]?.message ??
            "Operation request is invalid"
        )
      );
    }

    if (
      request.run_id !== undefined &&
      request.run_id !== this.#runId
    ) {
      return Promise.resolve(
        result(
          request,
          "failed",
          "RUN_SCOPE_MISMATCH",
          `Request belongs to ${request.run_id}, host belongs to ${this.#runId}`
        )
      );
    }

    const hash = requestContentHash(request);
    const existing = this.#idempotency.get(
      request.idempotency_key
    );

    if (existing) {
      if (existing.content_hash !== hash) {
        return Promise.resolve(
          result(
            request,
            "failed",
            "IDEMPOTENCY_CONFLICT",
            "The same idempotency key was used for different content"
          )
        );
      }

      return existing.promise;
    }

    const promise = this.#invokeFresh(request, scope);
    this.#idempotency.set(request.idempotency_key, {
      content_hash: hash,
      promise
    });

    return promise;
  }

  async #invokeFresh(
    request: OperationRequest,
    scope: OperationScope
  ): Promise<OperationResult> {
    const component =
      this.#snapshot.components[request.component];

    if (!component) {
      return result(
        request,
        "failed",
        "COMPONENT_BINDING_NOT_FOUND",
        `Component binding "${request.component}" is not in the run snapshot`
      );
    }

    if (request.deadline_at !== undefined) {
      const deadline = Date.parse(request.deadline_at);
      if (
        Number.isNaN(deadline) ||
        deadline <= Date.now()
      ) {
        return result(
          request,
          "failed",
          "DEADLINE_EXCEEDED",
          "Operation deadline is invalid or already expired",
          true
        );
      }
    }

    let session: WorkerSession;

    try {
      session = await this.#openSession(
        request,
        component
      );
    } catch (error) {
      const hostError =
        error instanceof HostInvocationError
          ? error
          : new HostInvocationError(
              "WORKER_START_FAILED",
              error instanceof Error
                ? error.message
                : String(error),
              true
            );

      return result(
        request,
        "failed",
        hostError.code,
        hostError.message,
        hostError.retryable
      );
    }

    const active: ActiveOperation = {
      request,
      scope,
      session,
      last_progress_sequence: -1,
      cancel_requested: false
    };

    this.#active.set(request.operation_id, active);

    if (request.deadline_at !== undefined) {
      const deadlineMs = Date.parse(request.deadline_at);
      const armDeadline = (): void => {
        const remaining = deadlineMs - Date.now();

        if (remaining <= 0) {
          this.#dispatchCancel(active, "deadline_exceeded");
          return;
        }

        active.deadline_timer = setTimeout(
          armDeadline,
          Math.min(remaining, 2_147_483_647)
        );
      };

      armDeadline();
    }

    const accepted = result(request, "accepted");
    this.#emit({
      type: "accepted",
      request,
      result: accepted,
      scope
    });

    let finalResult: OperationResult;

    try {
      const raw = await session.peer.request(
        "component.invoke",
        {
          request,
          config: component.config,
          bindings: component.bindings,
          scope,
          permission_grants: session.grants
        }
      );

      const validated = validateOperationMessage(raw);

      if (!validated.ok) {
        finalResult = result(
          request,
          "failed",
          "INVALID_OPERATION_RESULT",
          validated.diagnostics[0]?.message ??
            "Worker returned an invalid operation result"
        );
      } else {
        const candidate = raw as OperationResult;

        if (
          candidate.kind !== "operation-result" ||
          candidate.operation_id !== request.operation_id
        ) {
          finalResult = result(
            request,
            "failed",
            "PROTOCOL_RESULT_MISMATCH",
            "Worker result did not match the requested operation"
          );
        } else if (!terminalStatus(candidate.status)) {
          finalResult = result(
            request,
            "failed",
            "NON_TERMINAL_RESULT",
            `Worker resolved invoke with "${candidate.status}"`
          );
        } else {
          finalResult = candidate;
        }
      }
    } catch (error) {
      const code =
        error instanceof ProtocolError
          ? "WORKER_PROTOCOL_ERROR"
          : error instanceof WorkerExitedError
            ? "WORKER_EXITED"
            : error instanceof HostInvocationError
              ? error.code
              : "WORKER_UNAVAILABLE";

      finalResult = result(
        request,
        "termination_unknown",
        code,
        error instanceof Error
          ? error.message
          : String(error),
        true
      );
    } finally {
      if (active.deadline_timer !== undefined) {
        clearTimeout(active.deadline_timer);
      }
      if (active.force_timer !== undefined) {
        clearTimeout(active.force_timer);
      }

      this.#active.delete(request.operation_id);
      session.peer.close();
    }

    this.#emit({
      type: "completed",
      request,
      result: finalResult,
      scope
    });

    return finalResult;
  }

  async #openSession(
    request: OperationRequest,
    component: ResolvedComponentSnapshot
  ): Promise<WorkerSession> {
    const registration = this.#registry.get(
      component.implementation,
      component.version
    );

    if (!registration) {
      throw new HostInvocationError(
        "COMPONENT_NOT_REGISTERED",
        `${component.implementation}@${component.version} is no longer registered`
      );
    }

    const manifest = registration.manifest;
    const requestedPermissions = [...manifest.permissions];
    let grants: Record<string, string> = {};

    if (requestedPermissions.length > 0) {
      const resolver = this.#hostOptions.permission_resolver;

      if (!resolver) {
        throw new HostInvocationError(
          "PERMISSION_DENIED",
          "Component requests host permissions but no permission resolver is configured"
        );
      }

      const decision = await resolver({
        run_id: this.#runId,
        component_local_name: request.component,
        implementation: manifest.id,
        version: manifest.version,
        requested_permissions: requestedPermissions
      });

      if (!decision.allowed) {
        throw new HostInvocationError(
          "PERMISSION_DENIED",
          "Host permission resolver denied the component"
        );
      }

      grants = decision.opaque_grants ?? {};
    }

    const child = spawn(
      manifest.runtime.command,
      manifest.runtime.args ?? [],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: workerEnvironment(),
        ...(registration.source.package_root === undefined
          ? {}
          : { cwd: registration.source.package_root })
      }
    );

    let peer: JsonRpcPeer;

    const session: WorkerSession = {
      peer: undefined as unknown as JsonRpcPeer,
      manifest,
      grants,
      grace_ms:
        manifest.cancellation.grace_ms ??
        this.#hostOptions.default_cancel_grace_ms ??
        500
    };

    peer = new JsonRpcPeer(child, {
      max_frame_bytes:
        this.#hostOptions.max_frame_bytes ??
        4 * 1024 * 1024,
      on_notification: (method, params) =>
        this.#handleNotification(
          request.operation_id,
          method,
          params
        ),
      on_request: (method, params) =>
        this.#handleWorkerRequest(
          request.operation_id,
          method,
          params
        ),
      on_diagnostic: (code, message) =>
        this.#emit({
          type: "diagnostic",
          operation_id: request.operation_id,
          component: request.component,
          code,
          message
        }),
      on_failure: (error) =>
        this.#emit({
          type: "diagnostic",
          operation_id: request.operation_id,
          component: request.component,
          code: "WORKER_FAILURE",
          message:
            error instanceof WorkerExitedError
              ? "Worker exited before host-owned shutdown"
              : error.message
        })
    });

    session.peer = peer;

    let initialized: unknown;

    try {
      initialized = await withTimeout(
        peer.request("component.initialize", {
          protocol_version: "1",
          component_id: manifest.id,
          implementation_version: manifest.version,
          run_id: this.#runId,
          component_local_name: request.component,
          permission_grants: grants
        }),
        this.#hostOptions.initialize_timeout_ms ?? 3000,
        "Worker did not complete component.initialize in time"
      );
    } catch (error) {
      peer.terminate(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }

    const initialization = asRecord(initialized);

    if (
      initialization?.protocol_version !== "1" ||
      initialization.component_id !== manifest.id ||
      initialization.implementation_version !== manifest.version
    ) {
      peer.terminate(
        new HostInvocationError(
          "INITIALIZE_MISMATCH",
          "Worker initialize response does not match the registered component"
        )
      );
      throw new HostInvocationError(
        "INITIALIZE_MISMATCH",
        "Worker initialize response does not match the registered component"
      );
    }

    return session;
  }

  #handleNotification(
    operationId: string,
    method: string,
    params: unknown
  ): void {
    if (method !== "component.progress") {
      this.#emit({
        type: "diagnostic",
        operation_id: operationId,
        code: "UNKNOWN_NOTIFICATION",
        message: `Ignored worker notification "${method}"`
      });
      return;
    }

    const active = this.#active.get(operationId);
    if (!active) {
      this.#emit({
        type: "diagnostic",
        operation_id: operationId,
        code: "LATE_PROGRESS",
        message: "Ignored progress for an operation that is no longer active"
      });
      return;
    }

    const validation = validateOperationMessage(params);

    if (!validation.ok) {
      active.session.peer.terminate(
        new ProtocolError("Worker sent invalid progress message")
      );
      return;
    }

    const progress = params as OperationProgress;

    if (
      progress.kind !== "operation-progress" ||
      progress.operation_id !== operationId
    ) {
      active.session.peer.terminate(
        new ProtocolError("Worker progress does not match the operation")
      );
      return;
    }

    if (
      progress.sequence <= active.last_progress_sequence
    ) {
      this.#emit({
        type: "diagnostic",
        operation_id: operationId,
        component: active.request.component,
        code: "OUT_OF_ORDER_PROGRESS",
        message: "Ignored duplicate or out-of-order progress"
      });
      return;
    }

    active.last_progress_sequence = progress.sequence;

    this.#emit({
      type: "progress",
      request: active.request,
      progress,
      scope: active.scope
    });
  }

  async #handleWorkerRequest(
    operationId: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (method !== "host.invoke_binding") {
      throw new HostInvocationError(
        "METHOD_NOT_FOUND",
        `Worker may not call host method "${method}"`
      );
    }

    const parsed = parseBindingInvocation(params);
    const parent = this.#active.get(operationId);

    if (
      !parent ||
      parsed.parent_operation_id !== operationId
    ) {
      throw new HostInvocationError(
        "PARENT_OPERATION_NOT_ACTIVE",
        "Binding subcall parent is not active"
      );
    }

    const component =
      this.#snapshot.components[parent.request.component];
    const target = component?.bindings[parsed.binding];

    if (!target) {
      throw new HostInvocationError(
        "BINDING_NOT_RESOLVED",
        `Binding "${parsed.binding}" is not resolved in the run snapshot`
      );
    }

    this.#subcallCounter += 1;
    const childOperationId =
      `${operationId}:sub:${this.#subcallCounter}`;

    const childRequest: OperationRequest = {
      schema_version: "0.1",
      kind: "operation-request",
      operation_id: childOperationId,
      run_id: this.#runId,
      ...(parent.request.node_id === undefined
        ? {}
        : { node_id: parent.request.node_id }),
      component: target.local_name,
      operation: parsed.operation,
      inputs: parsed.inputs,
      idempotency_key:
        `${parent.request.idempotency_key}:${parsed.binding}:${parsed.idempotency_key ?? String(this.#subcallCounter)}`,
      ...(parent.request.deadline_at === undefined
        ? {}
        : { deadline_at: parent.request.deadline_at })
    };

    const childScope: OperationScope = {
      cancellation_scope_id:
        parent.scope.cancellation_scope_id,
      budget_scope_id: parent.scope.budget_scope_id,
      parent_operation_id: operationId
    };

    return this.#invokeInternal(
      childRequest,
      childScope
    );
  }

  #dispatchCancel(
    active: ActiveOperation,
    reason: string
  ): void {
    if (active.cancel_requested) return;
    active.cancel_requested = true;

    const cancel: OperationCancel = {
      schema_version: "0.1",
      kind: "operation-cancel",
      operation_id: active.request.operation_id,
      requested_at: new Date().toISOString(),
      reason
    };

    void active.session.peer
      .request("component.cancel", cancel)
      .catch(() => undefined);

    active.force_timer = setTimeout(() => {
      active.session.peer.terminate(
        new HostInvocationError(
          "WORKER_CANCEL_TIMEOUT",
          "Worker did not finish within the cancellation grace period",
          true
        )
      );
    }, active.session.grace_ms);
  }

  #emit(event: HostOperationEvent): void {
    this.#onEvent?.(event);
  }
}
