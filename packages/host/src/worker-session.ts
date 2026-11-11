import { spawn } from "node:child_process";
import type { OperationRequest } from "@open-scraping/contracts";
import type { ComponentRegistry, ResolvedComponentSnapshot } from "./registry.js";
import { JsonRpcPeer, WorkerExitedError } from "./protocol.js";
import { asRecord, HostInvocationError, withTimeout } from "./host-invocation.js";
import type { ComponentWorkerHostOptions, HostOperationEvent, WorkerSession } from "./host-types.js";

// Ownership-bound worker process setup, grants and initialize handshake.
function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP"
  ];

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}
interface SessionCallbacks {
  on_notification(method: string, params: unknown): void;
  on_request(method: string, params: unknown): Promise<unknown>;
  on_event(event: HostOperationEvent): void;
}

export async function openWorkerSession(
  registry: ComponentRegistry,
  options: ComponentWorkerHostOptions,
  runId: string,
  request: OperationRequest,
  component: ResolvedComponentSnapshot,
  callbacks: SessionCallbacks
): Promise<WorkerSession> {
  const registration = registry.get(
    component.implementation,
    component.version
  );

  if (!registration) {
    throw new HostInvocationError(
      "COMPONENT_NOT_REGISTERED",
      `${component.implementation}@${component.version} is no longer registered`
    );
  }

  const manifest = registration.manifest;
  const requestedPermissions = [...manifest.permissions];
  let grants: Record<string, string> = {};

  if (requestedPermissions.length > 0) {
    const resolver = options.permission_resolver;

    if (!resolver) {
      throw new HostInvocationError(
        "PERMISSION_DENIED",
        "Component requests host permissions but no permission resolver is configured"
      );
    }

    const decision = await resolver({
      run_id: runId,
      component_local_name: request.component,
      implementation: manifest.id,
      version: manifest.version,
      requested_permissions: requestedPermissions
    });

    if (!decision.allowed) {
      throw new HostInvocationError(
        "PERMISSION_DENIED",
        "Host permission resolver denied the component"
      );
    }

    grants = decision.opaque_grants ?? {};
  }

  const child = spawn(
    manifest.runtime.command,
    manifest.runtime.args ?? [],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnvironment(),
      ...(registration.source.package_root === undefined
        ? {}
        : { cwd: registration.source.package_root })
    }
  );

  let peer: JsonRpcPeer;

  const session: WorkerSession = {
    peer: undefined as unknown as JsonRpcPeer,
    manifest,
    grants,
    grace_ms:
      manifest.cancellation.grace_ms ??
      options.default_cancel_grace_ms ??
      500
  };

  peer = new JsonRpcPeer(child, {
    max_frame_bytes:
      options.max_frame_bytes ??
      4 * 1024 * 1024,
    on_notification: (method, params) =>
      callbacks.on_notification(method, params),
    on_request: (method, params) =>
      callbacks.on_request(method, params),
    on_diagnostic: (code, message) =>
      callbacks.on_event({
        type: "diagnostic",
        operation_id: request.operation_id,
        component: request.component,
        code,
        message
      }),
    on_failure: (error) =>
      callbacks.on_event({
        type: "diagnostic",
        operation_id: request.operation_id,
        component: request.component,
        code: "WORKER_FAILURE",
        message:
          error instanceof WorkerExitedError
            ? "Worker exited before host-owned shutdown"
            : error.message
      })
  });

  session.peer = peer;

  let initialized: unknown;

  try {
    initialized = await withTimeout(
      peer.request("component.initialize", {
        protocol_version: "1",
        component_id: manifest.id,
        implementation_version: manifest.version,
        run_id: runId,
        component_local_name: request.component,
        permission_grants: grants
      }),
      options.initialize_timeout_ms ?? 3000,
      "Worker did not complete component.initialize in time"
    );
  } catch (error) {
    peer.terminate(
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  }

  const initialization = asRecord(initialized);

  if (
    initialization?.protocol_version !== "1" ||
    initialization.component_id !== manifest.id ||
    initialization.implementation_version !== manifest.version
  ) {
    peer.terminate(
      new HostInvocationError(
        "INITIALIZE_MISMATCH",
        "Worker initialize response does not match the registered component"
      )
    );
    throw new HostInvocationError(
      "INITIALIZE_MISMATCH",
      "Worker initialize response does not match the registered component"
    );
  }

  return session;
}
