import type {
  ContractDiagnostic, FlowConfig, FlowReference, FlowValue,
  ManifestOperation, ManifestPort, ValidationResult
} from "./types.js";
import { validateFlowBindings } from "./validation-bindings.js";
import { detectDirectedCycle } from "./validation-common.js";
import { compileInlineSchema, validateFlowStructure } from "./validation-schema.js";

interface NodeContext {
  operation: ManifestOperation;
}

interface ResolvedValue {
  type: string;
  staticValue?: unknown;
  sourceNode?: string;
}
function isReference(value: FlowValue): value is FlowReference {
  return "$ref" in value;
}

function resolveReference(
  ref: string,
  flow: FlowConfig,
  nodesById: ReadonlyMap<string, FlowConfig["nodes"][number]>,
  nodeContexts: ReadonlyMap<string, NodeContext>,
  diagnostics: ContractDiagnostic[],
  path: string
): ResolvedValue | undefined {
  const flowInput = /^flow\.inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(ref);
  if (flowInput) {
    const name = flowInput[1];
    if (name === undefined) return undefined;
    const input = flow.inputs[name];
    if (!input) {
      diagnostics.push({
        code: "DANGLING_REF",
        path,
        message: `Flow input "${name}" does not exist`
      });
      return undefined;
    }

    return {
      type: input.type,
      staticValue: input.value
    };
  }

  const nodeOutput =
    /^nodes\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(
      ref
    );

  if (!nodeOutput) {
    diagnostics.push({
      code: "INVALID_REF",
      path,
      message: `Unsupported reference syntax: ${ref}`
    });
    return undefined;
  }

  const nodeId = nodeOutput[1];
  const portName = nodeOutput[2];
  if (nodeId === undefined || portName === undefined) return undefined;

  if (!nodesById.has(nodeId)) {
    diagnostics.push({
      code: "DANGLING_REF",
      path,
      message: `Node "${nodeId}" does not exist`
    });
    return undefined;
  }

  const operation = nodeContexts.get(nodeId)?.operation;
  const port = operation?.outputs[portName];

  if (!port) {
    diagnostics.push({
      code: "OUTPUT_NOT_FOUND",
      path,
      message: `Node "${nodeId}" does not declare output "${portName}"`
    });
    return undefined;
  }

  return {
    type: port.type,
    sourceNode: nodeId
  };
}

function acceptedTypes(port: ManifestPort): Set<string> {
  return new Set([port.type, ...(port.accepts ?? [])]);
}

// Check node/port types, references, declared outputs and graph cycles.
export function validateFlowConfig(
  value: unknown,
  manifests: readonly unknown[]
): ValidationResult<FlowConfig> {
  const structured = validateFlowStructure(value);
  if (!structured.ok) return structured;

  const flow = structured.value;
  const diagnostics: ContractDiagnostic[] = [];

  const componentContexts = validateFlowBindings(flow, manifests, diagnostics);

  const nodesById = new Map<string, FlowConfig["nodes"][number]>();
  for (let index = 0; index < flow.nodes.length; index += 1) {
    const node = flow.nodes[index];
    if (node === undefined) continue;

    if (nodesById.has(node.id)) {
      diagnostics.push({
        code: "DUPLICATE_NODE_ID",
        path: `/nodes/${index}/id`,
        message: `Duplicate node id "${node.id}"`
      });
    } else {
      nodesById.set(node.id, node);
    }
  }

  const nodeContexts = new Map<string, NodeContext>();

  for (let index = 0; index < flow.nodes.length; index += 1) {
    const node = flow.nodes[index];
    if (node === undefined) continue;

    const component = flow.components[node.component];
    if (!component) {
      diagnostics.push({
        code: "UNKNOWN_COMPONENT",
        path: `/nodes/${index}/component`,
        message: `Component "${node.component}" does not exist`
      });
      continue;
    }

    const componentContext = componentContexts.get(node.component);
    if (!componentContext) continue;

    const operation = componentContext.contract.operations.find(
      (candidate) => candidate.name === node.operation
    );

    if (!operation) {
      diagnostics.push({
        code: "OPERATION_NOT_PROVIDED",
        path: `/nodes/${index}/operation`,
        message:
          `${component.contract} does not provide operation "${node.operation}"`
      });
      continue;
    }

    nodeContexts.set(node.id, { operation });

    for (const [portName, port] of Object.entries(operation.inputs)) {
      if (port.required !== false && node.inputs[portName] === undefined) {
        diagnostics.push({
          code: "REQUIRED_INPUT_MISSING",
          path: `/nodes/${index}/inputs`,
          message: `Required input "${portName}" is missing`
        });
      }
    }

    for (const portName of Object.keys(node.inputs)) {
      if (!operation.inputs[portName]) {
        diagnostics.push({
          code: "UNKNOWN_INPUT",
          path: `/nodes/${index}/inputs/${portName}`,
          message: `Operation "${node.operation}" has no input "${portName}"`
        });
      }
    }
  }

  const nodeEdges = new Map<string, Set<string>>();
  for (const nodeId of nodesById.keys()) nodeEdges.set(nodeId, new Set());

  for (let index = 0; index < flow.nodes.length; index += 1) {
    const node = flow.nodes[index];
    if (node === undefined) continue;
    const operation = nodeContexts.get(node.id)?.operation;
    if (!operation) continue;

    for (const [portName, valueForPort] of Object.entries(node.inputs)) {
      const port = operation.inputs[portName];
      if (!port) continue;

      let resolved: ResolvedValue | undefined;

      if (isReference(valueForPort)) {
        resolved = resolveReference(
          valueForPort.$ref,
          flow,
          nodesById,
          nodeContexts,
          diagnostics,
          `/nodes/${index}/inputs/${portName}/$ref`
        );

        if (resolved?.sourceNode) {
          nodeEdges.get(node.id)?.add(resolved.sourceNode);
        }
      } else {
        resolved = {
          type: valueForPort.type,
          staticValue: valueForPort.value
        };
      }

      if (!resolved) continue;

      if (!acceptedTypes(port).has(resolved.type)) {
        diagnostics.push({
          code: "TYPE_MISMATCH",
          path: `/nodes/${index}/inputs/${portName}`,
          message:
            `Input "${portName}" accepts ${[...acceptedTypes(port)].join(", ")}, got ${resolved.type}`
        });
        continue;
      }

      if (port.schema && resolved.staticValue !== undefined) {
        const valueValidator = compileInlineSchema(
          port.schema,
          `/nodes/${index}/inputs/${portName}`,
          diagnostics
        );

        if (valueValidator && !valueValidator(resolved.staticValue)) {
          diagnostics.push({
            code: "VALUE_SCHEMA_MISMATCH",
            path: `/nodes/${index}/inputs/${portName}`,
            message:
              valueValidator.errors?.[0]?.message ??
              "Static input value does not satisfy the declared port schema"
          });
        }
      }
    }
  }

  const nodeCycle = detectDirectedCycle([...nodesById.keys()], nodeEdges);
  if (nodeCycle) {
    diagnostics.push({
      code: "NODE_CYCLE",
      path: "/nodes",
      message: `Node dependency cycle: ${nodeCycle.join(" -> ")}`
    });
  }

  for (const [outputName, outputRef] of Object.entries(flow.outputs)) {
    resolveReference(
      outputRef.$ref,
      flow,
      nodesById,
      nodeContexts,
      diagnostics,
      `/outputs/${outputName}/$ref`
    );
  }

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics
    };
  }

  return {
    ok: true,
    value: flow,
    diagnostics: []
  };
}
