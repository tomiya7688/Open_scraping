import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  validateComponentManifest,
  validateFlowConfig
} from "@open-scraping/contracts";
import type {
  ComponentManifest,
  ContractDiagnostic,
  FlowConfig
} from "@open-scraping/contracts";

export interface RegistrationSource {
  kind: "local-package";
  manifest_path: string;
  package_root?: string;
}

export interface RegisteredComponent {
  manifest: ComponentManifest;
  manifest_sha256: string;
  source: RegistrationSource;
}

export interface BindingCandidate {
  implementation: string;
  version: string;
  contract: string;
}

export interface BindingAvailability {
  name: string;
  required: boolean;
  contract: string;
  required_capabilities: string[];
  candidates: BindingCandidate[];
}

export interface ComponentAvailability {
  implementation: string;
  version: string;
  ready: boolean;
  bindings: BindingAvailability[];
}

export interface ResolvedBindingTarget {
  local_name: string;
  implementation: string;
  version: string;
  contract: string;
}

export interface ResolvedComponentSnapshot {
  implementation: string;
  version: string;
  contract: string;
  manifest_sha256: string;
  config: Record<string, unknown>;
  required_capabilities: string[];
  bindings: Record<string, ResolvedBindingTarget>;
}

export interface ComponentBindingSnapshot {
  schema_version: "0.1";
  kind: "component-binding-snapshot";
  flow_id: string;
  resolved_at: string;
  components: Record<string, ResolvedComponentSnapshot>;
}

export type RegistryResult<T> =
  | { ok: true; value: T; diagnostics: ContractDiagnostic[] }
  | { ok: false; diagnostics: ContractDiagnostic[] };

export type RemoveComponentResult =
  | {
      removed: true;
      reason: "removed";
      blocked_by_runs: [];
    }
  | {
      removed: false;
      reason: "in_use";
      blocked_by_runs: string[];
    }
  | {
      removed: false;
      reason: "not_found";
      blocked_by_runs: [];
    };

function registrationKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    );
  return `{${entries.join(",")}}`;
}

function manifestDigest(manifest: ComponentManifest): string {
  return createHash("sha256")
    .update(canonicalJson(manifest), "utf8")
    .digest("hex");
}

function providesRequirement(
  registration: RegisteredComponent,
  contractId: string,
  capabilities: readonly string[]
): boolean {
  const contract = registration.manifest.contracts.find(
    (candidate) => candidate.id === contractId
  );

  return (
    contract !== undefined &&
    capabilities.every((capability) =>
      contract.capabilities.includes(capability)
    )
  );
}

export class ComponentRegistry {
  readonly #registrations = new Map<string, RegisteredComponent>();
  readonly #usageByRun = new Map<string, Set<string>>();

  register(
    manifestValue: unknown,
    source: RegistrationSource
  ): RegistryResult<RegisteredComponent> {
    const validation = validateComponentManifest(manifestValue);
    if (!validation.ok) return validation;

    const manifest = jsonClone(validation.value);
    const digest = manifestDigest(manifest);
    const key = registrationKey(manifest.id, manifest.version);
    const existing = this.#registrations.get(key);

    if (existing) {
      if (existing.manifest_sha256 === digest) {
        return {
          ok: true,
          value: jsonClone(existing),
          diagnostics: []
        };
      }

      return {
        ok: false,
        diagnostics: [
          {
            code: "COMPONENT_ALREADY_REGISTERED",
            path: "/",
            message:
              `${key} is already registered with a different manifest`
          }
        ]
      };
    }

    const registration: RegisteredComponent = {
      manifest,
      manifest_sha256: digest,
      source: jsonClone(source)
    };

    this.#registrations.set(key, registration);

    return {
      ok: true,
      value: jsonClone(registration),
      diagnostics: []
    };
  }

  async registerFromFile(
    manifestPath: string,
    packageRoot?: string
  ): Promise<RegistryResult<RegisteredComponent>> {
    let raw: string;

    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "MANIFEST_READ_FAILED",
            path: manifestPath,
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "MANIFEST_JSON_INVALID",
            path: manifestPath,
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      };
    }

    const source: RegistrationSource =
      packageRoot === undefined
        ? {
            kind: "local-package",
            manifest_path: manifestPath
          }
        : {
            kind: "local-package",
            manifest_path: manifestPath,
            package_root: packageRoot
          };

    return this.register(parsed, source);
  }

  list(): RegisteredComponent[] {
    return [...this.#registrations.values()]
      .sort((left, right) => {
        const idOrder = left.manifest.id.localeCompare(right.manifest.id);
        return idOrder !== 0
          ? idOrder
          : left.manifest.version.localeCompare(right.manifest.version);
      })
      .map((registration) => jsonClone(registration));
  }

  get(id: string, version: string): RegisteredComponent | undefined {
    const registration = this.#registrations.get(
      registrationKey(id, version)
    );
    return registration ? jsonClone(registration) : undefined;
  }

  getAvailability(
    id: string,
    version: string
  ): RegistryResult<ComponentAvailability> {
    const registration = this.#registrations.get(
      registrationKey(id, version)
    );

    if (!registration) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "COMPONENT_NOT_REGISTERED",
            path: "/",
            message: `${id}@${version} is not registered`
          }
        ]
      };
    }

    const bindings: BindingAvailability[] = [];

    for (const [name, requirement] of Object.entries(
      registration.manifest.bindings ?? {}
    )) {
      const requiredCapabilities = requirement.capabilities ?? [];
      const candidates = [...this.#registrations.values()]
        .filter((candidate) =>
          providesRequirement(
            candidate,
            requirement.contract,
            requiredCapabilities
          )
        )
        .map((candidate) => ({
          implementation: candidate.manifest.id,
          version: candidate.manifest.version,
          contract: requirement.contract
        }))
        .sort((left, right) => {
          const idOrder = left.implementation.localeCompare(
            right.implementation
          );
          return idOrder !== 0
            ? idOrder
            : left.version.localeCompare(right.version);
        });

      bindings.push({
        name,
        required: requirement.required !== false,
        contract: requirement.contract,
        required_capabilities: [...requiredCapabilities],
        candidates
      });
    }

    return {
      ok: true,
      value: {
        implementation: registration.manifest.id,
        version: registration.manifest.version,
        ready: bindings.every(
          (binding) => !binding.required || binding.candidates.length > 0
        ),
        bindings
      },
      diagnostics: []
    };
  }

  resolveFlowBindings(
    flowValue: unknown,
    resolvedAt = new Date().toISOString()
  ): RegistryResult<ComponentBindingSnapshot> {
    const manifests = [...this.#registrations.values()].map(
      (registration) => registration.manifest
    );

    const validation = validateFlowConfig(flowValue, manifests);
    if (!validation.ok) return validation;

    const flow: FlowConfig = validation.value;
    const components: Record<string, ResolvedComponentSnapshot> = {};

    for (const [localName, binding] of Object.entries(flow.components)) {
      const registration = this.#registrations.get(
        registrationKey(
          binding.implementation,
          binding.implementation_version
        )
      );

      if (!registration) {
        return {
          ok: false,
          diagnostics: [
            {
              code: "COMPONENT_NOT_REGISTERED",
              path: `/components/${localName}`,
              message:
                `${binding.implementation}@${binding.implementation_version} is not registered`
            }
          ]
        };
      }

      const resolvedBindings: Record<string, ResolvedBindingTarget> = {};

      for (const [bindingName, targetLocalName] of Object.entries(
        binding.bindings ?? {}
      )) {
        const target = flow.components[targetLocalName];
        if (!target) {
          return {
            ok: false,
            diagnostics: [
              {
                code: "BINDING_TARGET_NOT_FOUND",
                path:
                  `/components/${localName}/bindings/${bindingName}`,
                message:
                  `Binding target "${targetLocalName}" does not exist`
              }
            ]
          };
        }

        resolvedBindings[bindingName] = {
          local_name: targetLocalName,
          implementation: target.implementation,
          version: target.implementation_version,
          contract: target.contract
        };
      }

      components[localName] = {
        implementation: binding.implementation,
        version: binding.implementation_version,
        contract: binding.contract,
        manifest_sha256: registration.manifest_sha256,
        config: jsonClone(binding.config),
        required_capabilities: [...(binding.requires ?? [])],
        bindings: resolvedBindings
      };
    }

    return {
      ok: true,
      value: {
        schema_version: "0.1",
        kind: "component-binding-snapshot",
        flow_id: flow.id,
        resolved_at: resolvedAt,
        components
      },
      diagnostics: []
    };
  }

  markRunUsage(
    runId: string,
    snapshot: ComponentBindingSnapshot
  ): void {
    const registrations = new Set<string>();

    for (const component of Object.values(snapshot.components)) {
      registrations.add(
        registrationKey(component.implementation, component.version)
      );
    }

    this.#usageByRun.set(runId, registrations);
  }

  releaseRun(runId: string): void {
    this.#usageByRun.delete(runId);
  }

  runsUsing(id: string, version: string): string[] {
    const key = registrationKey(id, version);
    const runs: string[] = [];

    for (const [runId, registrations] of this.#usageByRun) {
      if (registrations.has(key)) runs.push(runId);
    }

    return runs.sort();
  }

  remove(id: string, version: string): RemoveComponentResult {
    const key = registrationKey(id, version);

    if (!this.#registrations.has(key)) {
      return {
        removed: false,
        reason: "not_found",
        blocked_by_runs: []
      };
    }

    const blockedByRuns = this.runsUsing(id, version);
    if (blockedByRuns.length > 0) {
      return {
        removed: false,
        reason: "in_use",
        blocked_by_runs: blockedByRuns
      };
    }

    this.#registrations.delete(key);

    return {
      removed: true,
      reason: "removed",
      blocked_by_runs: []
    };
  }
}
