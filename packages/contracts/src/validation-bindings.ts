import type { ComponentManifest, ContractDiagnostic, FlowConfig, ManifestContract } from "./types.js";
import { detectDirectedCycle } from "./validation-common.js";
import { validateComponentManifest } from "./validation-manifest.js";
import { compileInlineSchema } from "./validation-schema.js";

export interface ComponentContext {
  manifest: ComponentManifest;
  contract: ManifestContract;
}
function keyForManifest(id: string, version: string): string {
  return `${id}@${version}`;
}

// Match implementation/version/capabilities and explicit binding dependencies.
export function validateFlowBindings(
  flow: FlowConfig, manifests: readonly unknown[], diagnostics: ContractDiagnostic[]
): Map<string, ComponentContext> {
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
  return componentContexts;
}
