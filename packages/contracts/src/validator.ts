import { Ajv2020 } from "ajv/dist/2020.js";

import {
  COMPONENT_MANIFEST_SCHEMA,
  DATA_REF_SCHEMA,
  FLOW_CONFIG_SCHEMA,
  OPERATION_MESSAGE_SCHEMA
} from "./schemas.js";
import type {
  ComponentManifest,
  ContractDiagnostic,
  DataRef,
  FlowConfig,
  FlowReference,
  FlowValue,
  ManifestContract,
  ManifestOperation,
  ManifestPort,
  ValidationResult
} from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});

const validateFlowSchema = ajv.compile(FLOW_CONFIG_SCHEMA);
const validateManifestSchema = ajv.compile(COMPONENT_MANIFEST_SCHEMA);
const validateDataRefSchema = ajv.compile(DATA_REF_SCHEMA);
const validateOperationSchema = ajv.compile(OPERATION_MESSAGE_SCHEMA);

function schemaDiagnostics(
  errors: readonly {
    instancePath?: string;
    keyword?: string;
    message?: string;
  }[] | null | undefined,
  code = "SCHEMA_INVALID"
): ContractDiagnostic[] {
  return (errors ?? []).map((error) => ({
    code,
    path: error.instancePath || "/",
    message: `${error.keyword ?? "schema"}: ${error.message ?? "validation failed"}`
  }));
}

function validateBySchema<T>(
  validator: typeof validateFlowSchema,
  value: unknown,
  code = "SCHEMA_INVALID"
): ValidationResult<T> {
  if (validator(value)) {
    return {
      ok: true,
      value: value as T,
      diagnostics: []
    };
  }

  return {
    ok: false,
    diagnostics: schemaDiagnostics(validator.errors, code)
  };
}

export function validateFlowStructure(
  value: unknown
): ValidationResult<FlowConfig> {
  return validateBySchema<FlowConfig>(validateFlowSchema, value);
}

export function validateComponentManifest(
  value: unknown
): ValidationResult<ComponentManifest> {
  return validateBySchema<ComponentManifest>(
    validateManifestSchema,
    value,
    "MANIFEST_SCHEMA_INVALID"
  );
}

export function validateDataRef(value: unknown): ValidationResult<DataRef> {
  const structured = validateBySchema<DataRef>(
    validateDataRefSchema,
    value,
    "DATA_REF_SCHEMA_INVALID"
  );

  if (!structured.ok) return structured;

  if (
    structured.value.lifetime.expires_at !== undefined &&
    Number.isNaN(Date.parse(structured.value.lifetime.expires_at))
  ) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "INVALID_TIMESTAMP",
          path: "/lifetime/expires_at",
          message: "expires_at must be a parseable absolute timestamp"
        }
      ]
    };
  }

  return structured;
}

export function validateOperationMessage(
  value: unknown
): ValidationResult<Record<string, unknown>> {
  return validateBySchema<Record<string, unknown>>(
    validateOperationSchema,
    value,
    "OPERATION_MESSAGE_SCHEMA_INVALID"
  );
}

interface ComponentContext {
  manifest: ComponentManifest;
  contract: ManifestContract;
}

interface NodeContext {
  operation: ManifestOperation;
}

interface ResolvedValue {
  type: string;
  staticValue?: unknown;
  sourceNode?: string;
}

function keyForManifest(id: string, version: string): string {
  return `${id}@${version}`;
}

function isReference(value: FlowValue): value is FlowReference {
  return "$ref" in value;
}

function compileInlineSchema(
  schema: Record<string, unknown>,
  path: string,
  diagnostics: ContractDiagnostic[]
) {
  try {
    return ajv.compile(schema);
  } catch (error) {
    diagnostics.push({
      code: "MANIFEST_SCHEMA_INVALID",
      path,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function detectDirectedCycle(
  vertices: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>
): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(vertex: string): string[] | undefined {
    const current = state.get(vertex) ?? 0;
    if (current === 2) return undefined;
    if (current === 1) {
      const start = stack.lastIndexOf(vertex);
      return [...stack.slice(Math.max(0, start)), vertex];
    }

    state.set(vertex, 1);
    stack.push(vertex);

    for (const dependency of edges.get(vertex) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    stack.pop();
    state.set(vertex, 2);
    return undefined;
  }

  for (const vertex of vertices) {
    const cycle = visit(vertex);
    if (cycle) return cycle;
  }

  return undefined;
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

export function validateFlowConfig(
  value: unknown,
  manifests: readonly unknown[]
): ValidationResult<FlowConfig> {
  const structured = validateFlowStructure(value);
  if (!structured.ok) return structured;

  const flow = structured.value;
  const diagnostics: ContractDiagnostic[] = [];

  const manifestIndex = new Map<string, ComponentManifest>();
  for (let index = 0; index < manifests.length; index += 1) {
    const candidate = validateComponentManifest(manifests[index]);
    if (!candidate.ok) {
      for (const diagnostic of candidate.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `/manifests/${index}${diagnostic.path === "/" ? "" : diagnostic.path}`
        });
      }
      continue;
    }

    const key = keyForManifest(candidate.value.id, candidate.value.version);
    if (manifestIndex.has(key)) {
      diagnostics.push({
        code: "DUPLICATE_MANIFEST",
        path: `/manifests/${index}`,
        message: `Duplicate component manifest ${key}`
      });
      continue;
    }

    manifestIndex.set(key, candidate.value);
  }

  const componentContexts = new Map<string, ComponentContext>();

  for (const [localName, binding] of Object.entries(flow.components)) {
    const manifest = manifestIndex.get(
      keyForManifest(binding.implementation, binding.implementation_version)
    );

    if (!manifest) {
      diagnostics.push({
        code: "MANIFEST_NOT_FOUND",
        path: `/components/${localName}`,
        message:
          `No manifest for ${binding.implementation}@${binding.implementation_version}`
      });
      continue;
    }

    const contract = manifest.contracts.find(
      (candidate) => candidate.id === binding.contract
    );

    if (!contract) {
      diagnostics.push({
        code: "CONTRACT_NOT_PROVIDED",
        path: `/components/${localName}/contract`,
        message:
          `${manifest.id}@${manifest.version} does not provide ${binding.contract}`
      });
      continue;
    }

    componentContexts.set(localName, { manifest, contract });

    for (const capability of binding.requires ?? []) {
      if (!contract.capabilities.includes(capability)) {
        diagnostics.push({
          code: "MISSING_CAPABILITY",
          path: `/components/${localName}/requires`,
          message:
            `${binding.contract} does not declare required capability "${capability}"`
        });
      }
    }

    const configValidator = compileInlineSchema(
      manifest.settings_schema,
      `/components/${localName}/config`,
      diagnostics
    );

    if (configValidator && !configValidator(binding.config)) {
      diagnostics.push({
        code: "CONFIG_SCHEMA_MISMATCH",
        path: `/components/${localName}/config`,
        message:
          configValidator.errors?.[0]?.message ??
          "Component config does not satisfy settings_schema"
      });
    }
  }

  const bindingEdges = new Map<string, Set<string>>();

  for (const [localName, binding] of Object.entries(flow.components)) {
    const context = componentContexts.get(localName);
    const declared = context?.manifest.bindings ?? {};
    const provided = binding.bindings ?? {};
    const edges = new Set<string>();
    bindingEdges.set(localName, edges);

    for (const [bindingName, targetName] of Object.entries(provided)) {
      edges.add(targetName);

      const requirement = declared[bindingName];
      if (!requirement) {
        diagnostics.push({
          code: "UNKNOWN_BINDING",
          path: `/components/${localName}/bindings/${bindingName}`,
          message: `Binding "${bindingName}" is not declared by the component manifest`
        });
        continue;
      }

      const target = flow.components[targetName];
      if (!target) {
        diagnostics.push({
          code: "BINDING_TARGET_NOT_FOUND",
          path: `/components/${localName}/bindings/${bindingName}`,
          message: `Binding target "${targetName}" does not exist`
        });
        continue;
      }

      if (target.contract !== requirement.contract) {
        diagnostics.push({
          code: "BINDING_CONTRACT_MISMATCH",
          path: `/components/${localName}/bindings/${bindingName}`,
          message:
            `Binding "${bindingName}" requires ${requirement.contract}, got ${target.contract}`
        });
      }

      const targetContext = componentContexts.get(targetName);
      for (const capability of requirement.capabilities ?? []) {
        if (!targetContext?.contract.capabilities.includes(capability)) {
          diagnostics.push({
            code: "BINDING_CAPABILITY_MISMATCH",
            path: `/components/${localName}/bindings/${bindingName}`,
            message:
              `Binding target "${targetName}" lacks capability "${capability}"`
          });
        }
      }
    }

    for (const [bindingName, requirement] of Object.entries(declared)) {
      if (requirement.required !== false && provided[bindingName] === undefined) {
        diagnostics.push({
          code: "MISSING_BINDING",
          path: `/components/${localName}/bindings`,
          message: `Required binding "${bindingName}" is missing`
        });
      }
    }
  }

  const bindingCycle = detectDirectedCycle(
    Object.keys(flow.components),
    bindingEdges
  );
  if (bindingCycle) {
    diagnostics.push({
      code: "COMPONENT_BINDING_CYCLE",
      path: "/components",
      message: `Component binding cycle: ${bindingCycle.join(" -> ")}`
    });
  }

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
