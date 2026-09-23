import {
  validateFlowStructure
} from "@open-scraping/contracts";
import type {
  ContractDiagnostic,
  FlowConfig,
  FlowNode,
  FlowReference,
  FlowValue,
  OperationCancel,
  OperationError,
  OperationRequest,
  OperationResult,
  ValidationResult
} from "@open-scraping/contracts";

export interface FlowInvoker {
  invoke(request: OperationRequest): Promise<OperationResult>;
  cancel(request: OperationCancel): Promise<void>;
}

export interface ExecutionPlanNode {
  node: FlowNode;
  dependencies: string[];
}

export interface ExecutionPlan {
  flow: FlowConfig;
  nodes: ExecutionPlanNode[];
}

export type NodeExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface NodeRunSnapshot {
  node_id: string;
  status: NodeExecutionStatus;
  operation_id?: string;
  outputs?: Record<string, unknown>;
  error?: OperationError;
}

export type FlowRunStatus =
  | "created"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "stopped";

export interface FlowRunSnapshot {
  run_id: string;
  flow_id: string;
  status: FlowRunStatus;
  started_at?: string;
  finished_at?: string;
  nodes: Record<string, NodeRunSnapshot>;
  outputs: Record<string, unknown>;
}

export interface FlowRunOptions {
  run_id: string;
  max_inline_output_bytes?: number;
  now?: () => number;
}

interface MutableNodeState {
  node_id: string;
  status: NodeExecutionStatus;
  operation_id?: string;
  outputs?: Record<string, unknown>;
  error?: OperationError;
}

interface ResolvedReference {
  found: boolean;
  value?: unknown;
}

const NODE_REF =
  /^nodes\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
const FLOW_INPUT_REF =
  /^flow\.inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;

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

function nodeDependencies(node: FlowNode): string[] {
  const dependencies = new Set<string>();

  for (const input of Object.values(node.inputs)) {
    if (!("$ref" in input)) continue;
    const match = NODE_REF.exec(input.$ref);
    const source = match?.[1];
    if (source !== undefined) dependencies.add(source);
  }

  return [...dependencies].sort();
}

function detectCycle(
  nodeIds: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>
): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(nodeId: string): string[] | undefined {
    const current = state.get(nodeId) ?? 0;
    if (current === 2) return undefined;

    if (current === 1) {
      const start = stack.lastIndexOf(nodeId);
      return [...stack.slice(Math.max(0, start)), nodeId];
    }

    state.set(nodeId, 1);
    stack.push(nodeId);

    for (const dependency of dependencies.get(nodeId) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    stack.pop();
    state.set(nodeId, 2);
    return undefined;
  }

  for (const nodeId of nodeIds) {
    const cycle = visit(nodeId);
    if (cycle) return cycle;
  }

  return undefined;
}

function validateRefTarget(
  ref: FlowReference,
  flow: FlowConfig,
  nodeIds: ReadonlySet<string>,
  path: string,
  diagnostics: ContractDiagnostic[]
): void {
  const flowInput = FLOW_INPUT_REF.exec(ref.$ref);
  if (flowInput) {
    const name = flowInput[1];
    if (name !== undefined && flow.inputs[name] === undefined) {
      diagnostics.push({
        code: "DANGLING_REF",
        path,
        message: `Flow input "${name}" does not exist`
      });
    }
    return;
  }

  const nodeOutput = NODE_REF.exec(ref.$ref);
  if (nodeOutput) {
    const nodeId = nodeOutput[1];
    if (nodeId !== undefined && !nodeIds.has(nodeId)) {
      diagnostics.push({
        code: "DANGLING_REF",
        path,
        message: `Node "${nodeId}" does not exist`
      });
    }
    return;
  }

  diagnostics.push({
    code: "INVALID_REF",
    path,
    message: `Unsupported reference syntax: ${ref.$ref}`
  });
}

export function createExecutionPlan(
  value: unknown
): ValidationResult<ExecutionPlan> {
  const structured = validateFlowStructure(value);
  if (!structured.ok) return structured;

  const flow = structured.value;
  const diagnostics: ContractDiagnostic[] = [];
  const nodeIds = new Set<string>();
  const dependencies = new Map<string, string[]>();

  for (let index = 0; index < flow.nodes.length; index += 1) {
    const node = flow.nodes[index];
    if (node === undefined) continue;

    if (nodeIds.has(node.id)) {
      diagnostics.push({
        code: "DUPLICATE_NODE_ID",
        path: `/nodes/${index}/id`,
        message: `Duplicate node id "${node.id}"`
      });
    } else {
      nodeIds.add(node.id);
    }

    if (flow.components[node.component] === undefined) {
      diagnostics.push({
        code: "UNKNOWN_COMPONENT",
        path: `/nodes/${index}/component`,
        message: `Component "${node.component}" does not exist`
      });
    }
  }

  for (let index = 0; index < flow.nodes.length; index += 1) {
    const node = flow.nodes[index];
    if (node === undefined) continue;

    const deps = nodeDependencies(node);
    dependencies.set(node.id, deps);

    for (const [inputName, input] of Object.entries(node.inputs)) {
      if ("$ref" in input) {
        validateRefTarget(
          input,
          flow,
          nodeIds,
          `/nodes/${index}/inputs/${inputName}/$ref`,
          diagnostics
        );
      }
    }
  }

  for (const [outputName, output] of Object.entries(flow.outputs)) {
    validateRefTarget(
      output,
      flow,
      nodeIds,
      `/outputs/${outputName}/$ref`,
      diagnostics
    );
  }

  const cycle = detectCycle([...nodeIds], dependencies);
  if (cycle) {
    diagnostics.push({
      code: "NODE_CYCLE",
      path: "/nodes",
      message: `Node dependency cycle: ${cycle.join(" -> ")}`
    });
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      flow,
      nodes: flow.nodes.map((node) => ({
        node,
        dependencies: dependencies.get(node.id) ?? []
      }))
    },
    diagnostics: []
  };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
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
      outputs: this.#resolveAvailableFlowOutputs()
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
      this.#markBlockedNodes(pending);

      if (this.#stopRequested) {
        if (this.#active.size > 0) {
          await Promise.race(this.#active.values());
          continue;
        }
        break;
      }

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
      const resolved = this.#resolveFlowValue(value);
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

  #resolveFlowValue(value: FlowValue): ResolvedReference {
    if (!("$ref" in value)) {
      return { found: true, value: value.value };
    }

    return this.#resolveReference(value);
  }

  #resolveReference(ref: FlowReference): ResolvedReference {
    const flowInput = FLOW_INPUT_REF.exec(ref.$ref);
    if (flowInput) {
      const inputName = flowInput[1];
      if (inputName === undefined) return { found: false };
      const input = this.#plan.flow.inputs[inputName];
      return input === undefined
        ? { found: false }
        : { found: true, value: input.value };
    }

    const nodeOutput = NODE_REF.exec(ref.$ref);
    if (!nodeOutput) return { found: false };

    const nodeId = nodeOutput[1];
    const port = nodeOutput[2];
    if (nodeId === undefined || port === undefined) {
      return { found: false };
    }

    const outputs = this.#states.get(nodeId)?.outputs;
    if (
      outputs === undefined ||
      !Object.prototype.hasOwnProperty.call(outputs, port)
    ) {
      return { found: false };
    }

    return {
      found: true,
      value: outputs[port]
    };
  }

  #resolveAvailableFlowOutputs(): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};

    for (const [name, ref] of Object.entries(this.#plan.flow.outputs)) {
      const resolved = this.#resolveReference(ref);
      if (resolved.found) outputs[name] = resolved.value;
    }

    return outputs;
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
