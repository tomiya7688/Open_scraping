import type {
  DataRef,
  OperationError,
  OperationStatus
} from "@open-scraping/contracts";

import type {
  FlowRunSnapshot,
  NodeExecutionStatus
} from "./execution.js";
import type { SchedulerSnapshot } from "./scheduler.js";

export type JournalRunStatus =
  | FlowRunSnapshot["status"]
  | "recovering"
  | "needs_attention";

export interface JournalOperationRecord {
  operation_id: string;
  node_id: string;
  generation: number;
  status: OperationStatus;
  idempotency_key: string;
  updated_at: string;
  checkpoint_ref?: string;
  outputs?: Record<string, unknown>;
  error?: OperationError;
}

export interface JournalNodeRecord {
  node_id: string;
  status: NodeExecutionStatus;
  generation: number;
  operation_id?: string;
  outputs?: Record<string, unknown>;
  checkpoint_ref?: string;
  error?: OperationError;
}

export interface RunJournalSnapshot {
  schema_version: "0.1";
  kind: "run-journal-snapshot";
  run_id: string;
  flow_id: string;
  flow_revision: string;
  execution_revision: string;
  generation: number;
  status: JournalRunStatus;
  created_at: string;
  updated_at: string;
  nodes: Record<string, JournalNodeRecord>;
  operations: Record<string, JournalOperationRecord>;
  scheduler_state?: SchedulerSnapshot;
}

export interface RunJournalEvent {
  run_id: string;
  generation: number;
  sequence?: number;
  event_type: string;
  recorded_at: string;
  payload: Record<string, unknown>;
}

export interface StoredRunJournal {
  snapshot: RunJournalSnapshot;
  events: RunJournalEvent[];
}

export interface RunStateStore {
  save_snapshot(snapshot: RunJournalSnapshot): Promise<void>;
  append_event(event: RunJournalEvent): Promise<number>;
  load_run(run_id: string): Promise<StoredRunJournal | undefined>;
}

export type RecoveryAction =
  | {
      kind: "reuse_completed";
      node_id: string;
      operation_id?: string;
    }
  | {
      kind: "reconcile_required";
      node_id: string;
      operation_id: string;
      checkpoint_ref?: string;
      reason: "incomplete_operation" | "termination_unknown";
    }
  | {
      kind: "ready_for_new_operation";
      node_id: string;
    }
  | {
      kind: "blocked";
      node_id: string;
      reason: string;
    };

export interface RecoveryDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface RecoveryPlan {
  run_id: string;
  previous_generation: number;
  next_generation: number;
  status: "recovering" | "needs_attention";
  actions: RecoveryAction[];
  diagnostics: RecoveryDiagnostic[];
  restored_scheduler_state?: SchedulerSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function maybeDataRef(value: unknown): DataRef | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema_version !== "0.1" ||
    value.kind !== "data-ref" ||
    typeof value.type !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.ref !== "string"
  ) {
    return undefined;
  }
  return value as unknown as DataRef;
}

function collectReferenceDiagnostics(
  value: unknown,
  nowMs: number,
  path: string,
  diagnostics: RecoveryDiagnostic[]
): void {
  const ref = maybeDataRef(value);
  if (ref) {
    if (ref.lifetime.scope === "ttl") {
      const expiresAt = ref.lifetime.expires_at;
      const parsed = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
      if (Number.isNaN(parsed) || parsed <= nowMs) {
        diagnostics.push({
          code: "DATA_REF_EXPIRED",
          path,
          message: `DataRef ${ref.provider}:${ref.ref} is expired or has an invalid TTL`
        });
      }
    }

    if (ref.lifetime.scope === "operation") {
      diagnostics.push({
        code: "DATA_REF_OPERATION_LIFETIME_ENDED",
        path,
        message:
          `Operation-scoped DataRef ${ref.provider}:${ref.ref} cannot be assumed valid after recovery`
      });
    }

    if (
      ref.lifetime.scope === "persistent" &&
      ref.persistence.state !== "committed"
    ) {
      diagnostics.push({
        code: "DATA_REF_NOT_COMMITTED",
        path,
        message:
          `Persistent DataRef ${ref.provider}:${ref.ref} was not committed before recovery`
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectReferenceDiagnostics(
        value[index],
        nowMs,
        `${path}/${index}`,
        diagnostics
      );
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectReferenceDiagnostics(
        child,
        nowMs,
        `${path}/${key}`,
        diagnostics
      );
    }
  }
}

function operationForNode(
  snapshot: RunJournalSnapshot,
  node: JournalNodeRecord
): JournalOperationRecord | undefined {
  return node.operation_id === undefined
    ? undefined
    : snapshot.operations[node.operation_id];
}

export function createRecoveryPlan(
  snapshot: RunJournalSnapshot,
  nowMs = Date.now()
): RecoveryPlan {
  const diagnostics: RecoveryDiagnostic[] = [];
  const actions: RecoveryAction[] = [];

  for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
    if (node.outputs !== undefined) {
      collectReferenceDiagnostics(
        node.outputs,
        nowMs,
        `/nodes/${nodeId}/outputs`,
        diagnostics
      );
    }

    const operation = operationForNode(snapshot, node);

    if (node.status === "succeeded") {
      actions.push({
        kind: "reuse_completed",
        node_id: nodeId,
        ...(node.operation_id === undefined
          ? {}
          : { operation_id: node.operation_id })
      });
      continue;
    }

    if (operation) {
      if (
        operation.status === "accepted" ||
        operation.status === "running"
      ) {
        actions.push({
          kind: "reconcile_required",
          node_id: nodeId,
          operation_id: operation.operation_id,
          ...(operation.checkpoint_ref === undefined
            ? {}
            : { checkpoint_ref: operation.checkpoint_ref }),
          reason: "incomplete_operation"
        });
        continue;
      }

      if (operation.status === "termination_unknown") {
        actions.push({
          kind: "reconcile_required",
          node_id: nodeId,
          operation_id: operation.operation_id,
          ...(operation.checkpoint_ref === undefined
            ? {}
            : { checkpoint_ref: operation.checkpoint_ref }),
          reason: "termination_unknown"
        });
        continue;
      }

      if (
        operation.status === "failed" ||
        operation.status === "cancelled"
      ) {
        actions.push({
          kind: "blocked",
          node_id: nodeId,
          reason:
            `Previous operation ended with ${operation.status}; explicit retry policy is required`
        });
        continue;
      }
    }

    if (node.status === "pending") {
      actions.push({
        kind: "ready_for_new_operation",
        node_id: nodeId
      });
      continue;
    }

    actions.push({
      kind: "blocked",
      node_id: nodeId,
      reason:
        `Node state ${node.status} cannot be resumed automatically`
    });
  }

  if (diagnostics.length > 0) {
    for (const action of actions) {
      if (action.kind === "ready_for_new_operation") {
        action.kind = "blocked" as never;
      }
    }
  }

  return {
    run_id: snapshot.run_id,
    previous_generation: snapshot.generation,
    next_generation: snapshot.generation + 1,
    status:
      diagnostics.length > 0 ||
      actions.some(
        (action) =>
          action.kind === "reconcile_required" ||
          action.kind === "blocked"
      )
        ? "needs_attention"
        : "recovering",
    actions,
    diagnostics,
    ...(snapshot.scheduler_state === undefined
      ? {}
      : { restored_scheduler_state: snapshot.scheduler_state })
  };
}

export function acceptRecoveredGeneration(
  snapshot: RunJournalSnapshot,
  plan: RecoveryPlan,
  now = new Date().toISOString()
): RunJournalSnapshot {
  if (
    plan.run_id !== snapshot.run_id ||
    plan.previous_generation !== snapshot.generation
  ) {
    throw new Error("recovery plan does not match the stored run generation");
  }

  return {
    ...snapshot,
    generation: plan.next_generation,
    status: plan.status,
    updated_at: now,
    nodes: Object.fromEntries(
      Object.entries(snapshot.nodes).map(([id, node]) => [
        id,
        { ...node, generation: plan.next_generation }
      ])
    )
  };
}

export function isEventForCurrentGeneration(
  snapshot: RunJournalSnapshot,
  event: RunJournalEvent
): boolean {
  return (
    event.run_id === snapshot.run_id &&
    event.generation === snapshot.generation
  );
}
