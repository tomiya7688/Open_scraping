import { createHash } from "node:crypto";

import { validateFlowConfig } from "@open-scraping/contracts";
import type {
  ContractDiagnostic,
  FlowConfig,
  ValidationResult
} from "@open-scraping/contracts";

import type { ComponentRegistry } from "./registry.js";

export interface StoredFlow {
  flow: FlowConfig;
  revision: string;
}

export type CatalogWriteResult =
  | { ok: true; entry: StoredFlow }
  | {
      ok: false;
      reason: "invalid" | "exists" | "not_found" | "revision_mismatch" | "id_mismatch";
      diagnostics: ContractDiagnostic[];
    };

function digest(value: FlowConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function copy(entry: StoredFlow): StoredFlow {
  return structuredClone(entry);
}

/**
 * 0.x development API catalog. Entries are only retained in memory:
 * this is NOT a run journal or durable flow repository.
 */
export class FlowCatalog {
  readonly #registry: ComponentRegistry;
  readonly #entries = new Map<string, StoredFlow>();

  constructor(registry: ComponentRegistry) {
    this.#registry = registry;
  }

  validate(raw: unknown): ValidationResult<FlowConfig> {
    return validateFlowConfig(
      raw,
      this.#registry.list().map((item) => item.manifest)
    );
  }

  get(id: string): StoredFlow | undefined {
    const entry = this.#entries.get(id);
    return entry ? copy(entry) : undefined;
  }

  create(raw: unknown): CatalogWriteResult {
    const result = this.validate(raw);
    if (!result.ok) {
      return { ok: false, reason: "invalid", diagnostics: result.diagnostics };
    }

    if (this.#entries.has(result.value.id)) {
      return { ok: false, reason: "exists", diagnostics: [] };
    }

    const entry = {
      flow: structuredClone(result.value),
      revision: digest(result.value)
    };
    this.#entries.set(entry.flow.id, entry);
    return { ok: true, entry: copy(entry) };
  }

  update(id: string, raw: unknown, expectedRevision: string): CatalogWriteResult {
    const existing = this.#entries.get(id);
    if (!existing) {
      return { ok: false, reason: "not_found", diagnostics: [] };
    }
    if (existing.revision !== expectedRevision) {
      return { ok: false, reason: "revision_mismatch", diagnostics: [] };
    }

    const result = this.validate(raw);
    if (!result.ok) {
      return { ok: false, reason: "invalid", diagnostics: result.diagnostics };
    }
    if (result.value.id !== id) {
      return { ok: false, reason: "id_mismatch", diagnostics: [] };
    }

    const entry = {
      flow: structuredClone(result.value),
      revision: digest(result.value)
    };
    this.#entries.set(id, entry);
    return { ok: true, entry: copy(entry) };
  }
}
