export const LOCAL_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_-]*$";
export const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
export const TYPE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*/v[1-9][0-9]*$";
export const FLOW_REF_PATTERN =
  "^(?:flow\\.inputs\\.[A-Za-z_][A-Za-z0-9_-]*|nodes\\.[A-Za-z_][A-Za-z0-9_-]*\\.outputs\\.[A-Za-z_][A-Za-z0-9_-]*)$";

const localName = { type: "string", pattern: LOCAL_NAME_PATTERN };
const identifier = { type: "string", pattern: IDENTIFIER_PATTERN };
const typeId = { type: "string", pattern: TYPE_ID_PATTERN };
const jsonValue = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: "#/$defs/jsonValue" } },
    {
      type: "object",
      additionalProperties: { $ref: "#/$defs/jsonValue" }
    }
  ]
};

export const FLOW_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://open-scraping.local/schema/flow-config-0.3.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "kind",
    "id",
    "inputs",
    "components",
    "nodes",
    "execution",
    "outputs"
  ],
  properties: {
    schema_version: { const: "0.3" },
    kind: { const: "flow" },
    id: identifier,
    example_only: { type: "boolean" },
    description: { type: "string" },
    inputs: {
      type: "object",
      propertyNames: localName,
      additionalProperties: { $ref: "#/$defs/typedValue" }
    },
    components: {
      type: "object",
      propertyNames: localName,
      additionalProperties: { $ref: "#/$defs/componentBinding" }
    },
    nodes: {
      type: "array",
      items: { $ref: "#/$defs/node" }
    },
    execution: { $ref: "#/$defs/execution" },
    outputs: {
      type: "object",
      propertyNames: localName,
      additionalProperties: { $ref: "#/$defs/reference" }
    }
  },
  $defs: {
    jsonValue,
    typedValue: {
      type: "object",
      additionalProperties: false,
      required: ["type", "value"],
      properties: {
        type: typeId,
        value: { $ref: "#/$defs/jsonValue" }
      }
    },
    reference: {
      type: "object",
      additionalProperties: false,
      required: ["$ref"],
      properties: {
        $ref: { type: "string", pattern: FLOW_REF_PATTERN }
      }
    },
    flowValue: {
      oneOf: [
        { $ref: "#/$defs/reference" },
        { $ref: "#/$defs/typedValue" }
      ]
    },
    componentBinding: {
      type: "object",
      additionalProperties: false,
      required: [
        "implementation",
        "implementation_version",
        "contract",
        "config"
      ],
      properties: {
        implementation: identifier,
        implementation_version: { type: "string", minLength: 1 },
        contract: typeId,
        config: { type: "object" },
        bindings: {
          type: "object",
          propertyNames: localName,
          additionalProperties: localName
        },
        requires: {
          type: "array",
          uniqueItems: true,
          items: localName
        }
      }
    },
    node: {
      type: "object",
      additionalProperties: false,
      required: ["id", "component", "operation", "inputs"],
      properties: {
        id: localName,
        component: localName,
        operation: localName,
        inputs: {
          type: "object",
          propertyNames: localName,
          additionalProperties: { $ref: "#/$defs/flowValue" }
        },
        policy: {
          type: "object",
          additionalProperties: false,
          properties: {
            on_failure: {
              enum: ["stop", "continue_independent"]
            }
          }
        }
      }
    },
    execution: {
      type: "object",
      additionalProperties: false,
      required: ["max_parallel_nodes", "timeout_ms", "on_node_failure"],
      properties: {
        max_parallel_nodes: { type: "integer", minimum: 1 },
        timeout_ms: { type: "integer", minimum: 1 },
        on_node_failure: {
          enum: ["stop", "continue_independent"]
        },
        resources: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["min_start_interval_ms", "max_in_flight"],
            properties: {
              min_start_interval_ms: {
                type: "integer",
                minimum: 0
              },
              max_in_flight: {
                type: "integer",
                minimum: 1
              }
            }
          }
        }
      }
    }
  }
} as const;

export const COMPONENT_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://open-scraping.local/schema/component-manifest-0.1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "kind",
    "id",
    "version",
    "protocol",
    "contracts",
    "settings_schema",
    "permissions",
    "cancellation",
    "runtime"
  ],
  properties: {
    schema_version: { const: "0.1" },
    kind: { const: "component-manifest" },
    id: identifier,
    version: { type: "string", minLength: 1 },
    protocol: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { const: "open-scraping.component-rpc" },
        version: { const: "1" }
      }
    },
    contracts: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/contract" }
    },
    settings_schema: {
      type: "object"
    },
    bindings: {
      type: "object",
      propertyNames: localName,
      additionalProperties: { $ref: "#/$defs/bindingRequirement" }
    },
    permissions: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 }
    },
    cancellation: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: {
          enum: ["cooperative", "worker_terminate", "unsupported"]
        },
        grace_ms: {
          type: "integer",
          minimum: 0
        }
      }
    },
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["transport", "command"],
      properties: {
        transport: { const: "stdio-jsonrpc" },
        command: { type: "string", minLength: 1 },
        args: {
          type: "array",
          items: { type: "string" }
        },
        platforms: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 }
        }
      }
    }
  },
  $defs: {
    port: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: typeId,
        accepts: {
          type: "array",
          uniqueItems: true,
          items: typeId
        },
        required: { type: "boolean" },
        schema: { type: "object" }
      }
    },
    operation: {
      type: "object",
      additionalProperties: false,
      required: ["name", "inputs", "outputs"],
      properties: {
        name: localName,
        inputs: {
          type: "object",
          propertyNames: localName,
          additionalProperties: { $ref: "#/$defs/port" }
        },
        outputs: {
          type: "object",
          propertyNames: localName,
          additionalProperties: { $ref: "#/$defs/port" }
        }
      }
    },
    contract: {
      type: "object",
      additionalProperties: false,
      required: ["id", "capabilities", "operations"],
      properties: {
        id: typeId,
        capabilities: {
          type: "array",
          uniqueItems: true,
          items: localName
        },
        operations: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/operation" }
        }
      }
    },
    bindingRequirement: {
      type: "object",
      additionalProperties: false,
      required: ["contract"],
      properties: {
        contract: typeId,
        required: { type: "boolean" },
        capabilities: {
          type: "array",
          uniqueItems: true,
          items: localName
        }
      }
    }
  }
} as const;

export const DATA_REF_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://open-scraping.local/schema/data-ref-0.1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "kind",
    "type",
    "provider",
    "ref",
    "revision",
    "access",
    "lifetime",
    "persistence",
    "dispose_required"
  ],
  properties: {
    schema_version: { const: "0.1" },
    kind: { const: "data-ref" },
    type: typeId,
    provider: identifier,
    ref: { type: "string", minLength: 1 },
    revision: { type: "string", minLength: 1 },
    access: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["host-mediated", "binding"] },
        readable_by: {
          type: "array",
          uniqueItems: true,
          items: identifier
        }
      }
    },
    lifetime: {
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: { enum: ["operation", "run", "ttl", "persistent"] },
        expires_at: { type: "string", minLength: 1 }
      }
    },
    persistence: {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: {
        state: { enum: ["ephemeral", "committing", "committed"] },
        commit_ref: { type: "string", minLength: 1 }
      }
    },
    dispose_required: { type: "boolean" }
  },
  allOf: [
    {
      if: {
        properties: {
          lifetime: {
            properties: {
              scope: { const: "ttl" }
            },
            required: ["scope"]
          }
        }
      },
      then: {
        properties: {
          lifetime: {
            required: ["scope", "expires_at"]
          }
        }
      }
    }
  ]
} as const;

export const OPERATION_MESSAGE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://open-scraping.local/schema/operation-message-0.1.json",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "kind",
        "operation_id",
        "component",
        "operation",
        "inputs",
        "idempotency_key"
      ],
      properties: {
        schema_version: { const: "0.1" },
        kind: { const: "operation-request" },
        operation_id: identifier,
        run_id: identifier,
        node_id: localName,
        component: identifier,
        operation: localName,
        inputs: { type: "object" },
        idempotency_key: { type: "string", minLength: 1 },
        deadline_at: { type: "string", minLength: 1 }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "kind",
        "operation_id",
        "status",
        "outputs"
      ],
      properties: {
        schema_version: { const: "0.1" },
        kind: { const: "operation-result" },
        operation_id: identifier,
        status: {
          enum: [
            "accepted",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "termination_unknown"
          ]
        },
        outputs: { type: "object" },
        checkpoint_ref: { type: "string", minLength: 1 },
        error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "retryable"],
          properties: {
            code: { type: "string", minLength: 1 },
            message: { type: "string" },
            retryable: { type: "boolean" },
            details: {}
          }
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "kind",
        "operation_id",
        "sequence"
      ],
      properties: {
        schema_version: { const: "0.1" },
        kind: { const: "operation-progress" },
        operation_id: identifier,
        sequence: { type: "integer", minimum: 0 },
        completed: { type: "number", minimum: 0 },
        total: { type: "number", minimum: 0 },
        message: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "kind",
        "operation_id",
        "requested_at"
      ],
      properties: {
        schema_version: { const: "0.1" },
        kind: { const: "operation-cancel" },
        operation_id: identifier,
        requested_at: { type: "string", minLength: 1 },
        reason: { type: "string" }
      }
    }
  ]
} as const;
