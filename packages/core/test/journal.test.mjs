import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptRecoveredGeneration,
  createRecoveryPlan,
  isEventForCurrentGeneration
} from "../dist/index.js";

function baseSnapshot() {
  return {
    schema_version: "0.1",
    kind: "run-journal-snapshot",
    run_id: "run-1",
    flow_id: "flow-1",
    flow_revision: "flow-rev-1",
    execution_revision: "exec-rev-1",
    generation: 3,
    status: "running",
    created_at: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:01:00.000Z",
    nodes: {
      saved: {
        node_id: "saved",
        status: "succeeded",
        generation: 3,
        operation_id: "op-saved",
        outputs: {
          ref: {
            schema_version: "0.1",
            kind: "data-ref",
            type: "example.saved/v1",
            provider: "store",
            ref: "saved-1",
            revision: "1",
            access: { mode: "host-mediated" },
            lifetime: { scope: "persistent" },
            persistence: {
              state: "committed",
              commit_ref: "commit-1"
            },
            dispose_required: false
          }
        }
      },
      active: {
        node_id: "active",
        status: "running",
        generation: 3,
        operation_id: "op-active",
        checkpoint_ref: "checkpoint-active"
      },
      pending: {
        node_id: "pending",
        status: "pending",
        generation: 3
      }
    },
    operations: {
      "op-saved": {
        operation_id: "op-saved",
        node_id: "saved",
        generation: 3,
        status: "succeeded",
        idempotency_key: "saved-key",
        updated_at: "2026-09-28T00:00:30.000Z",
        outputs: {}
      },
      "op-active": {
        operation_id: "op-active",
        node_id: "active",
        generation: 3,
        status: "running",
        idempotency_key: "active-key",
        checkpoint_ref: "checkpoint-active",
        updated_at: "2026-09-28T00:01:00.000Z"
      }
    },
    scheduler_state: {
      schema_version: "0.1",
      kind: "shared-scheduler-state",
      captured_at_epoch_ms: 1000,
      resources: {
        network: {
          policy: {
            min_start_interval_ms: 5000,
            max_in_flight: 1,
            budget_limit: 10
          },
          in_flight: 0,
          budget_used: 4,
          start_times_epoch_ms: [900],
          next_start_not_before_epoch_ms: 5900
        }
      }
    }
  };
}

test("recovery reuses successful nodes and requires reconciliation for incomplete operations", () => {
  const plan = createRecoveryPlan(baseSnapshot(), Date.parse("2026-09-28T00:02:00Z"));

  assert.equal(plan.previous_generation, 3);
  assert.equal(plan.next_generation, 4);
  assert.equal(plan.status, "needs_attention");

  assert.ok(
    plan.actions.some(
      (action) =>
        action.kind === "reuse_completed" &&
        action.node_id === "saved"
    )
  );
  assert.ok(
    plan.actions.some(
      (action) =>
        action.kind === "reconcile_required" &&
        action.node_id === "active" &&
        action.operation_id === "op-active" &&
        action.checkpoint_ref === "checkpoint-active"
    )
  );
  assert.ok(
    plan.actions.some(
      (action) =>
        action.kind === "ready_for_new_operation" &&
        action.node_id === "pending"
    )
  );

  assert.equal(
    plan.restored_scheduler_state.resources.network.budget_used,
    4
  );
  assert.equal(
    plan.restored_scheduler_state.resources.network.next_start_not_before_epoch_ms,
    5900
  );
});

test("expired and uncommitted DataRefs force needs_attention without implicit reacquisition", () => {
  const snapshot = baseSnapshot();
  snapshot.nodes.saved.outputs = {
    expired: {
      schema_version: "0.1",
      kind: "data-ref",
      type: "example.saved/v1",
      provider: "store",
      ref: "expired",
      revision: "1",
      access: { mode: "host-mediated" },
      lifetime: {
        scope: "ttl",
        expires_at: "2026-09-27T00:00:00Z"
      },
      persistence: { state: "ephemeral" },
      dispose_required: false
    },
    committing: {
      schema_version: "0.1",
      kind: "data-ref",
      type: "example.saved/v1",
      provider: "store",
      ref: "committing",
      revision: "1",
      access: { mode: "host-mediated" },
      lifetime: { scope: "persistent" },
      persistence: { state: "committing" },
      dispose_required: false
    }
  };

  const plan = createRecoveryPlan(
    snapshot,
    Date.parse("2026-09-28T00:02:00Z")
  );

  assert.equal(plan.status, "needs_attention");
  assert.ok(
    plan.diagnostics.some(
      (diagnostic) => diagnostic.code === "DATA_REF_EXPIRED"
    )
  );
  assert.ok(
    plan.diagnostics.some(
      (diagnostic) => diagnostic.code === "DATA_REF_NOT_COMMITTED"
    )
  );
});

test("new generation rejects delayed events from the old generation", () => {
  const snapshot = baseSnapshot();
  const plan = createRecoveryPlan(
    snapshot,
    Date.parse("2026-09-28T00:02:00Z")
  );
  const recovered = acceptRecoveredGeneration(
    snapshot,
    plan,
    "2026-09-28T00:02:01Z"
  );

  assert.equal(recovered.generation, 4);
  assert.equal(
    isEventForCurrentGeneration(recovered, {
      run_id: "run-1",
      generation: 3,
      event_type: "operation.completed",
      recorded_at: "2026-09-28T00:02:02Z",
      payload: {}
    }),
    false
  );
  assert.equal(
    isEventForCurrentGeneration(recovered, {
      run_id: "run-1",
      generation: 4,
      event_type: "operation.reconciled",
      recorded_at: "2026-09-28T00:02:02Z",
      payload: {}
    }),
    true
  );
});
