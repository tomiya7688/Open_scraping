import type { FlowConfig, FlowReference, FlowValue } from "@open-scraping/contracts";
import type { MutableNodeState } from "./execution-types.js";

// Pure resolution from flow inputs and the current run's node outputs.
interface ResolvedReference {
  found: boolean;
  value?: unknown;
}
const NODE_REF =
  /^nodes\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
const FLOW_INPUT_REF =
  /^flow\.inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
export function resolveFlowValue(value: FlowValue, flow: FlowConfig, states: ReadonlyMap<string, MutableNodeState>): ResolvedReference {
  if (!("$ref" in value)) {
    return { found: true, value: value.value };
  }

  return resolveReference(value, flow, states);
}

function resolveReference(ref: FlowReference, flow: FlowConfig, states: ReadonlyMap<string, MutableNodeState>): ResolvedReference {
  const flowInput = FLOW_INPUT_REF.exec(ref.$ref);
  if (flowInput) {
    const inputName = flowInput[1];
    if (inputName === undefined) return { found: false };
    const input = flow.inputs[inputName];
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

  const outputs = states.get(nodeId)?.outputs;
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

export function resolveAvailableFlowOutputs(flow: FlowConfig, states: ReadonlyMap<string, MutableNodeState>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};

  for (const [name, ref] of Object.entries(flow.outputs)) {
    const resolved = resolveReference(ref, flow, states);
    if (resolved.found) outputs[name] = resolved.value;
  }

  return outputs;
}
