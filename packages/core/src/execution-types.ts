import type {
  FlowConfig, FlowNode, OperationCancel, OperationError, OperationRequest, OperationResult
} from "@open-scraping/contracts";

// Public plan/run types and the abstract FlowInvoker; no behavior lives here.
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

export interface MutableNodeState {
  node_id: string;
  status: NodeExecutionStatus;
  operation_id?: string;
  outputs?: Record<string, unknown>;
  error?: OperationError;
}
