export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TypedValue {
  type: string;
  value: JsonValue;
}

export interface FlowReference {
  $ref: string;
}

export type FlowValue = TypedValue | FlowReference;

export interface FlowComponentBinding {
  implementation: string;
  implementation_version: string;
  contract: string;
  config: Record<string, unknown>;
  bindings?: Record<string, string>;
  requires?: string[];
}

export interface FlowNodePolicy {
  on_failure?: "stop" | "continue_independent";
}

export interface FlowNode {
  id: string;
  component: string;
  operation: string;
  inputs: Record<string, FlowValue>;
  policy?: FlowNodePolicy;
}

export interface ResourcePolicy {
  min_start_interval_ms: number;
  max_in_flight: number;
}

export interface FlowExecutionPolicy {
  max_parallel_nodes: number;
  timeout_ms: number;
  on_node_failure: "stop" | "continue_independent";
  resources?: Record<string, ResourcePolicy>;
}

export interface FlowConfig {
  schema_version: "0.3";
  kind: "flow";
  id: string;
  example_only?: boolean;
  description?: string;
  inputs: Record<string, TypedValue>;
  components: Record<string, FlowComponentBinding>;
  nodes: FlowNode[];
  execution: FlowExecutionPolicy;
  outputs: Record<string, FlowReference>;
}

export interface ManifestPort {
  type: string;
  accepts?: string[];
  required?: boolean;
  schema?: Record<string, unknown>;
}

export interface ManifestOperation {
  name: string;
  inputs: Record<string, ManifestPort>;
  outputs: Record<string, ManifestPort>;
}

export interface ManifestContract {
  id: string;
  capabilities: string[];
  operations: ManifestOperation[];
}

export interface ManifestBindingRequirement {
  contract: string;
  required?: boolean;
  capabilities?: string[];
}

export interface ComponentManifest {
  schema_version: "0.1";
  kind: "component-manifest";
  id: string;
  version: string;
  protocol: {
    name: "open-scraping.component-rpc";
    version: "1";
  };
  contracts: ManifestContract[];
  settings_schema: Record<string, unknown>;
  bindings?: Record<string, ManifestBindingRequirement>;
  permissions: string[];
  cancellation: {
    mode: "cooperative" | "worker_terminate" | "unsupported";
    grace_ms?: number;
  };
  runtime: {
    transport: "stdio-jsonrpc";
    command: string;
    args?: string[];
    platforms?: string[];
  };
}

export interface DataRef {
  schema_version: "0.1";
  kind: "data-ref";
  type: string;
  provider: string;
  ref: string;
  revision: string;
  access: {
    mode: "host-mediated" | "binding";
    readable_by?: string[];
  };
  lifetime: {
    scope: "operation" | "run" | "ttl" | "persistent";
    expires_at?: string;
  };
  persistence: {
    state: "ephemeral" | "committing" | "committed";
    commit_ref?: string;
  };
  dispose_required: boolean;
}

export interface ContractDiagnostic {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; diagnostics: ContractDiagnostic[] }
  | { ok: false; diagnostics: ContractDiagnostic[] };
