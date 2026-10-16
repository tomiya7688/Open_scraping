import type { FlowNode, OperationError, OperationRequest, OperationResult, ValidationResult } from "@open-scraping/contracts";
import { createExecutionPlan } from "./execution-plan.js";
import { utf8ByteLength } from "./inline-bytes.js";
import { resolveAvailableFlowOutputs, resolveFlowValue } from "./reference-resolution.js";
import type {
  ExecutionPlan, ExecutionPlanNode, FlowInvoker, FlowRunOptions, FlowRunSnapshot,
  FlowRunStatus, MutableNodeState, NodeRunSnapshot
} from "./execution-types.js";

export { createExecutionPlan } from "./execution-plan.js";
export type {
  FlowInvoker, ExecutionPlanNode, ExecutionPlan, NodeExecutionStatus,
  NodeRunSnapshot, FlowRunStatus, FlowRunSnapshot, FlowRunOptions
} from "./execution-types.js";

// FlowRun uniquely owns mutable node/run status and cancellation.
function operationError(
  code: string,
  message: string,
  retryable = false,
  details?: unknown
): OperationError {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, retryable, details };
}
export class FlowRun {
  readonly #plan: ExecutionPlan;
  readonly #invoker: FlowInvoker;
  readonly #runId: string;
  readonly #maxInlineOutputBytes: number;
  readonly #now: () => number;
  readonly #states = new Map<string, MutableNodeState>();
  readonly #active = new Map<string, Promise<void>>();
  readonly #nodeById = new Map<string, ExecutionPlanNode>();
  #status: FlowRunStatus = "created";
  #startedAt?: string;
  #finishedAt?: string;
  #stopRequested = false;
  #stopReason = "user_requested";
  #startPromise?: Promise<FlowRunSnapshot>;

  constructor(
    plan: ExecutionPlan,
    invoker: FlowInvoker,
    options: FlowRunOptions
  ) {
    this.#plan = plan;
    this.#invoker = invoker;
    this.#runId = options.run_id;
    this.#maxInlineOutputBytes =
      options.max_inline_output_bytes ?? 1024 * 1024;
    this.#now = options.now ?? Date.now;

    for (const planNode of plan.nodes) {
      this.#nodeById.set(planNode.node.id, planNode);
      this.#states.set(planNode.node.id, {
        node_id: planNode.node.id,
        status: "pending"
      });
    }
  }

  snapshot(): FlowRunSnapshot {
    const nodes: Record<string, NodeRunSnapshot> = {};

    for (const [nodeId, state] of this.#states) {
      nodes[nodeId] = {
        node_id: state.node_id,
        status: state.status,
        ...(state.operation_id === undefined
          ? {}
          : { operation_id: state.operation_id }),
        ...(state.outputs === undefined
          ? {}
          : { outputs: state.outputs }),
        ...(state.error === undefined ? {} : { error: state.error })
      };
    }

    return {
      run_id: this.#runId,
      flow_id: this.#plan.flow.id,
      status: this.#status,
      ...(this.#startedAt === undefined
        ? {}
        : { started_at: this.#startedAt }),
      ...(this.#finishedAt === undefined
        ? {}
        : { finished_at: this.#finishedAt }),
      nodes,
      outputs: resolveAvailableFlowOutputs(this.#plan.flow, this.#states)
    };
  }

  start(): Promise<FlowRunSnapshot> {
    if (this.#startPromise) return this.#startPromise;

    this.#status = "running";
    this.#startedAt = new Date(this.#now()).toISOString();
    this.#startPromise = this.#execute();
    return this.#startPromise;
  }

  async stop(reason = "user_requested"): Promise<void> {
    await this.#initiateStop(reason);
  }

  async #initiateStop(
    reason: string,
    excludeOperationId?: string
  ): Promise<void> {
    if (!this.#stopRequested) {
      this.#stopRequested = true;
      this.#stopReason = reason;
    }

    if (this.#status === "running") this.#status = "stopping";

    const requestedAt = new Date(this.#now()).toISOString();
    const cancellations: Promise<void>[] = [];

    for (const operationId of this.#active.keys()) {
      if (operationId === excludeOperationId) continue;

      cancellations.push(
        this.#invoker
          .cancel({
            schema_version: "0.1",
            kind: "operation-cancel",
            operation_id: operationId,
            requested_at: requestedAt,
            reason
          })
          .catch(() => undefined)
      );
    }

    await Promise.all(cancellations);
  }

  async #execute(): Promise<FlowRunSnapshot> {
    const pending = new Set(this.#plan.nodes.map(({ node }) => node.id));
    const deadlineMs =
      this.#now() + this.#plan.flow.execution.timeout_ms;

    while (pending.size > 0 || this.#active.size > 0) {
      if (this.#stopRequested) {
        if (this.#active.size > 0) {
          await Promise.race(this.#active.values());
          continue;
        }
        break;
      }

      this.#markBlockedNodes(pending);

      if (this.#now() >= deadlineMs) {
        await this.#initiateStop("run_timeout");
        continue;
      }

      let launched = false;

      for (const planNode of this.#plan.nodes) {
        if (
          this.#active.size >=
          this.#plan.flow.execution.max_parallel_nodes
        ) {
          break;
        }

        const nodeId = planNode.node.id;
        if (!pending.has(nodeId)) continue;

        const dependenciesSucceeded = planNode.dependencies.every(
          (dependency) =>
            this.#states.get(dependency)?.status === "succeeded"
        );

        if (!dependenciesSucceeded) continue;

        pending.delete(nodeId);
        this.#launch(planNode, deadlineMs);
        launched = true;
      }

      if (this.#active.size > 0) {
        await Promise.race(this.#active.values());
        continue;
      }

      if (!launched && pending.size > 0) {
        for (const nodeId of pending) {
          const state = this.#states.get(nodeId);
          if (!state) continue;
          state.status = "blocked";
          state.error = operationError(
            "UNRESOLVED_DEPENDENCY",
            "No executable dependency path remained"
          );
        }
        pending.clear();
      }
    }

    if (this.#stopRequested) {
      for (const state of this.#states.values()) {
        if (state.status === "pending") {
          state.status = "cancelled";
          state.error = operationError(
            "RUN_STOPPED_BEFORE_START",
            `Run stopped before the node started: ${this.#stopReason}`
          );
        }
      }
    }

    const states = [...this.#states.values()];
    this.#status = this.#stopRequested
      ? "stopped"
      : states.every((state) => state.status === "succeeded")
        ? "succeeded"
        : "failed";
    this.#finishedAt = new Date(this.#now()).toISOString();

    return this.snapshot();
  }

  #markBlockedNodes(pending: Set<string>): void {
    let changed = true;

    while (changed) {
      changed = false;

      for (const nodeId of [...pending]) {
        const planNode = this.#nodeById.get(nodeId);
        if (!planNode) continue;

        const failedDependency = planNode.dependencies.find(
          (dependency) => {
            const status = this.#states.get(dependency)?.status;
            return (
              status === "failed" ||
              status === "cancelled" ||
              status === "blocked"
            );
          }
        );

        if (failedDependency === undefined) continue;

        const state = this.#states.get(nodeId);
        if (!state) continue;

        state.status = "blocked";
        state.error = operationError(
          "DEPENDENCY_NOT_SUCCEEDED",
          `Dependency "${failedDependency}" did not succeed`
        );
        pending.delete(nodeId);
        changed = true;
      }
    }
  }

  #launch(planNode: ExecutionPlanNode, deadlineMs: number): void {
    const operationId =
      `${this.#runId}:${planNode.node.id}:1`;
    const promise = this.#executeNode(
      planNode,
      operationId,
      deadlineMs
    ).finally(() => {
      this.#active.delete(operationId);
    });

    this.#active.set(operationId, promise);
  }

  async #executeNode(
    planNode: ExecutionPlanNode,
    operationId: string,
    deadlineMs: number
  ): Promise<void> {
    const node = planNode.node;
    const state = this.#states.get(node.id);
    if (!state) return;

    state.status = "running";
    state.operation_id = operationId;

    const inputs: Record<string, unknown> = {};

    for (const [inputName, value] of Object.entries(node.inputs)) {
      const resolved = resolveFlowValue(value, this.#plan.flow, this.#states);
      if (!resolved.found) {
        state.status = "failed";
        state.error = operationError(
          "UNRESOLVED_INPUT",
          `Input "${inputName}" could not be resolved`
        );
        await this.#handleNodeFailure(node, operationId);
        return;
      }

      inputs[inputName] = resolved.value;
    }

    const request: OperationRequest = {
      schema_version: "0.1",
      kind: "operation-request",
      operation_id: operationId,
      run_id: this.#runId,
      node_id: node.id,
      component: node.component,
      operation: node.operation,
      inputs,
      idempotency_key: operationId,
      deadline_at: new Date(deadlineMs).toISOString()
    };

    let result: OperationResult;

    try {
      result = await this.#invoker.invoke(request);
    } catch (error) {
      state.status = "failed";
      state.error = operationError(
        "INVOKER_ERROR",
        error instanceof Error ? error.message : String(error),
        true
      );
      await this.#handleNodeFailure(node, operationId);
      return;
    }

    if (state.status !== "running") return;

    if (result.status === "succeeded") {
      let serialized: string;

      try {
        serialized = JSON.stringify(result.outputs);
      } catch (error) {
        state.status = "failed";
        state.error = operationError(
          "NON_JSON_OUTPUT",
          error instanceof Error ? error.message : String(error)
        );
        await this.#handleNodeFailure(node, operationId);
        return;
      }

      if (utf8ByteLength(serialized) > this.#maxInlineOutputBytes) {
        state.status = "failed";
        state.error = operationError(
          "INLINE_OUTPUT_LIMIT_EXCEEDED",
          "Operation returned too much inline data; return a DataRef instead"
        );
        await this.#handleNodeFailure(node, operationId);
        return;
      }

      state.status = "succeeded";
      state.outputs = result.outputs;
      return;
    }

    if (result.status === "cancelled") {
      state.status = "cancelled";
      state.error =
        result.error ??
        operationError("OPERATION_CANCELLED", "Operation was cancelled");
      return;
    }

    if (result.status === "termination_unknown") {
      state.status = "failed";
      state.error =
        result.error ??
        operationError(
          "TERMINATION_UNKNOWN",
          "Worker termination could not be confirmed",
          true
        );
      await this.#handleNodeFailure(node, operationId);
      return;
    }

    if (result.status === "failed") {
      state.status = "failed";
      state.error =
        result.error ??
        operationError("OPERATION_FAILED", "Operation failed");
      await this.#handleNodeFailure(node, operationId);
      return;
    }

    state.status = "failed";
    state.error = operationError(
      "NON_TERMINAL_RESULT",
      `Invoker resolved with non-terminal status "${result.status}"`
    );
    await this.#handleNodeFailure(node, operationId);
  }

  async #handleNodeFailure(
    node: FlowNode,
    operationId: string
  ): Promise<void> {
    const policy =
      node.policy?.on_failure ??
      this.#plan.flow.execution.on_node_failure;

    if (policy === "stop") {
      await this.#initiateStop("node_failure", operationId);
    }
  }

}

export function createFlowRun(
  flowValue: unknown,
  invoker: FlowInvoker,
  options: FlowRunOptions
): ValidationResult<FlowRun> {
  const plan = createExecutionPlan(flowValue);
  if (!plan.ok) return plan;

  return {
    ok: true,
    value: new FlowRun(plan.value, invoker, options),
    diagnostics: []
  };
}
