import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SqliteRunStateStore } from "../dist/index.js";

function snapshot(generation = 1) {
  return {
    schema_version: "0.1",
    kind: "run-journal-snapshot",
    run_id: "run-sqlite",
    flow_id: "flow",
    flow_revision: "flow-r1",
    execution_revision: "exec-r1",
    generation,
    status: "running",
    created_at: "2026-09-28T00:00:00Z",
    updated_at: `2026-09-28T00:00:0${generation}Z`,
    nodes: {
      save: {
        node_id: "save",
        status: "succeeded",
        generation,
        operation_id: "op-save",
        outputs: { collection: "collection-1" }
      },
      later: {
        node_id: "later",
        status: "failed",
        generation,
        operation_id: "op-later",
        error: {
          code: "FAIL",
          message: "later failed",
          retryable: false
        }
      }
    },
    operations: {
      "op-save": {
        operation_id: "op-save",
        node_id: "save",
        generation,
        status: "succeeded",
        idempotency_key: "save-key",
        updated_at: "2026-09-28T00:00:01Z",
        outputs: { collection: "collection-1" }
      },
      "op-later": {
        operation_id: "op-later",
        node_id: "later",
        generation,
        status: "failed",
        idempotency_key: "later-key",
        updated_at: "2026-09-28T00:00:02Z",
        error: {
          code: "FAIL",
          message: "later failed",
          retryable: false
        }
      }
    },
    scheduler_state: {
      schema_version: "0.1",
      kind: "shared-scheduler-state",
      captured_at_epoch_ms: 2000,
      resources: {
        source: {
          policy: {
            min_start_interval_ms: 1000,
            max_in_flight: 1,
            budget_limit: 10
          },
          in_flight: 0,
          budget_used: 7,
          start_times_epoch_ms: [1000],
          next_start_not_before_epoch_ms: 3000
        }
      }
    }
  };
}

test("SQLite store survives close/open and preserves successful node state plus scheduler state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-scraping-journal-"));
  const path = join(dir, "run-journal.sqlite");

  try {
    const first = new SqliteRunStateStore({ path });
    await first.open();
    await first.save_snapshot(snapshot());
    assert.equal(
      await first.append_event({
        run_id: "run-sqlite",
        generation: 1,
        event_type: "node.succeeded",
        recorded_at: "2026-09-28T00:00:01Z",
        payload: { node_id: "save" }
      }),
      1
    );
    first.close();

    const second = new SqliteRunStateStore({ path });
    await second.open();
    const loaded = await second.load_run("run-sqlite");

    assert.ok(loaded);
    assert.equal(loaded.snapshot.nodes.save.status, "succeeded");
    assert.equal(
      loaded.snapshot.nodes.save.outputs.collection,
      "collection-1"
    );
    assert.equal(
      loaded.snapshot.scheduler_state.resources.source.budget_used,
      7
    );
    assert.equal(
      loaded.snapshot.scheduler_state.resources.source.next_start_not_before_epoch_ms,
      3000
    );
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.events[0].sequence, 1);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale generation events and snapshots cannot overwrite a recovered generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-scraping-generation-"));
  const path = join(dir, "run-journal.sqlite");

  try {
    const store = new SqliteRunStateStore({ path });
    await store.open();
    await store.save_snapshot(snapshot(2));

    await assert.rejects(
      store.save_snapshot(snapshot(1)),
      /stale generation/
    );

    await assert.rejects(
      store.append_event({
        run_id: "run-sqlite",
        generation: 1,
        event_type: "late.operation.result",
        recorded_at: "2026-09-28T00:00:09Z",
        payload: {}
      }),
      /stale generation event/
    );

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fault injection after an earlier save never removes the successful record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-scraping-fault-"));
  const path = join(dir, "run-journal.sqlite");

  try {
    const store = new SqliteRunStateStore({ path });
    await store.open();
    await store.save_snapshot(snapshot());

    await store.append_event({
      run_id: "run-sqlite",
      generation: 1,
      event_type: "fault.injected",
      recorded_at: "2026-09-28T00:00:03Z",
      payload: { point: "after-save-before-later-node" }
    });
    store.close();

    const reopened = new SqliteRunStateStore({ path });
    await reopened.open();
    const loaded = await reopened.load_run("run-sqlite");

    assert.ok(loaded);
    assert.equal(loaded.snapshot.nodes.save.status, "succeeded");
    assert.equal(
      loaded.snapshot.nodes.save.outputs.collection,
      "collection-1"
    );
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
