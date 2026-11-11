import { Ajv2020 } from "ajv/dist/2020.js";
import {
  COMPONENT_MANIFEST_SCHEMA, DATA_REF_SCHEMA, FLOW_CONFIG_SCHEMA, OPERATION_MESSAGE_SCHEMA
} from "./schemas.js";
import type {
  ComponentManifest, ContractDiagnostic, DataRef, FlowConfig, ValidationResult
} from "./types.js";

// Validate wire structure independently from flow semantics.
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

type SchemaValidator = {
  (value: unknown): boolean;
  errors?: readonly {
    instancePath?: string;
    keyword?: string;
    message?: string;
  }[] | null;
};

function validateBySchema<T>(
  validator: SchemaValidator,
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
export function validateManifestStructure(value: unknown): ValidationResult<ComponentManifest> {
  return validateBySchema<ComponentManifest>(validateManifestSchema, value, "MANIFEST_SCHEMA_INVALID");
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
export function compileInlineSchema(
  schema: Record<string, unknown>,
  path: string,
  diagnostics: ContractDiagnostic[]
) {
  try {
    const inlineAjv = new Ajv2020({
      allErrors: true,
      strict: false
    });
    return inlineAjv.compile(schema);
  } catch (error) {
    diagnostics.push({
      code: "MANIFEST_SCHEMA_INVALID",
      path,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}
