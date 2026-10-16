import type { ComponentManifest, OperationProgress, OperationRequest, OperationResult } from "@open-scraping/contracts";
import type { JsonRpcPeer } from "./protocol.js";

// Public events/options and private session shapes. Mutable state is owned by RunComponentInvoker.
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
export interface WorkerSession {
  peer: JsonRpcPeer;
  manifest: ComponentManifest;
  grants: Record<string, string>;
  grace_ms: number;
}

export interface ActiveOperation {
  request: OperationRequest;
  scope: OperationScope;
  session: WorkerSession;
  last_progress_sequence: number;
  deadline_timer?: ReturnType<typeof setTimeout>;
  force_timer?: ReturnType<typeof setTimeout>;
  cancel_requested: boolean;
}

export interface IdempotencyRecord {
  content_hash: string;
  promise: Promise<OperationResult>;
}

export interface BindingInvocationParams {
  parent_operation_id: string;
  binding: string;
  operation: string;
  inputs: Record<string, unknown>;
  idempotency_key?: string;
}
