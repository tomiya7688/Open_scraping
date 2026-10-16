import { validateFlowStructure } from "@open-scraping/contracts";
import type {
  ContractDiagnostic, FlowConfig, FlowNode, FlowReference, ValidationResult
} from "@open-scraping/contracts";
import type { ExecutionPlan } from "./execution-types.js";

// Plan construction and dependency checks have no mutable run state.
const NODE_REF =
  /^nodes\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
const FLOW_INPUT_REF =
  /^flow\.inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
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
