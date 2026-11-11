import type { ComponentManifest, ContractDiagnostic, ValidationResult } from "./types.js";
import { compileInlineSchema, validateManifestStructure } from "./validation-schema.js";

// Validate manifest-local operation names and JSON settings schema.
export function validateComponentManifest(
  value: unknown
): ValidationResult<ComponentManifest> {
  const structured = validateManifestStructure(value);
  if (!structured.ok) return structured;

  const diagnostics: ContractDiagnostic[] = [];
  const contractIds = new Set<string>();

  for (
    let contractIndex = 0;
    contractIndex < structured.value.contracts.length;
    contractIndex += 1
  ) {
    const contract = structured.value.contracts[contractIndex];
    if (contract === undefined) continue;

    if (contractIds.has(contract.id)) {
      diagnostics.push({
        code: "DUPLICATE_CONTRACT",
        path: `/contracts/${contractIndex}/id`,
        message: `Duplicate provided contract "${contract.id}"`
      });
    } else {
      contractIds.add(contract.id);
    }

    const operationNames = new Set<string>();
    for (
      let operationIndex = 0;
      operationIndex < contract.operations.length;
      operationIndex += 1
    ) {
      const operation = contract.operations[operationIndex];
      if (operation === undefined) continue;

      if (operationNames.has(operation.name)) {
        diagnostics.push({
          code: "DUPLICATE_OPERATION",
          path:
            `/contracts/${contractIndex}/operations/${operationIndex}/name`,
          message:
            `Duplicate operation "${operation.name}" in ${contract.id}`
        });
      } else {
        operationNames.add(operation.name);
      }
    }
  }

  compileInlineSchema(
    structured.value.settings_schema,
    "/settings_schema",
    diagnostics
  );

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return structured;
}
