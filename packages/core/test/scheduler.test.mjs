import assert from "node:assert/strict";
import test from "node:test";

import {
  SchedulerCancelledError,
  SharedScheduler
} from "../dist/index.js";

class FakeClock {
  mono = 0;
  wall = 1_800_000_000_000;
  nextId = 1;
  timers = new Map();

  monotonic_now_ms() {
    return this.mono;
  }

  wall_now_ms() {
    return this.wall;
  }

  set_timer(callback, delay_ms) {
    const id = this.nextId++;
    this.timers.set(id, {
      at: this.mono + delay_ms,
      callback
    });
    return id;
  }

  clear_timer(handle) {
    this.timers.delete(handle);
  }

  advance(ms) {
    const target = this.mono + ms;
    while (true) {
      let selected;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!selected || timer.at < selected.timer.at) {
          selected = { id, timer };
        }
      }
      if (!selected) break;
      const delta = selected.timer.at - this.mono;
      this.mono = selected.timer.at;
      this.wall += delta;
      this.timers.delete(selected.id);
      selected.timer.callback();
    }
    const delta = target - this.mono;
    this.mono = target;
    this.wall += delta;
  }
}

function schedulerWith(clock, events = []) {
  return new SharedScheduler({
    clock,
    on_event: (event) => events.push(event)
  });
}

test("enforces start interval and applies a shortened policy only to waiting requests", async () => {
  const clock = new FakeClock();
  const events = [];
  const scheduler = schedulerWith(clock, events);
  scheduler.set_policy("network", {
    min_start_interval_ms: 1000,
    max_in_flight: 2
  });

  const first = await scheduler.acquire({
    request_id: "a",
    resource_keys: ["network"]
  });
  first.release();

  let granted = false;
  const secondPromise = scheduler.acquire({
    request_id: "b",
    resource_keys: ["network"]
  }).then((lease) => {
    granted = true;
    return lease;
  });

  clock.advance(400);
  await Promise.resolve();
  assert.equal(granted, false);

  scheduler.set_policy("network", {
    min_start_interval_ms: 500,
    max_in_flight: 2
  });
  clock.advance(99);
  await Promise.resolve();
  assert.equal(granted, false);

  clock.advance(1);
  const second = await secondPromise;
  assert.equal(granted, true);
  second.release();

  const update = events.findLast((event) => event.type === "policy_updated");
  assert.equal(update.applies_to, "not_started_requests");
  assert.equal(update.old_policy.min_start_interval_ms, 1000);
  assert.equal(update.new_policy.min_start_interval_ms, 500);
});

test("component not_before is preserved when interval policy becomes shorter", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  scheduler.set_policy("remote", {
    min_start_interval_ms: 1000,
    max_in_flight: 1
  });

  const first = await scheduler.acquire({
    request_id: "first",
    resource_keys: ["remote"]
  });
  first.release();

  let granted = false;
  const pending = scheduler.acquire({
    request_id: "later",
    resource_keys: ["remote"],
    not_before_epoch_ms: clock.wall_now_ms() + 3000
  }).then((lease) => {
    granted = true;
    return lease;
  });

  scheduler.set_policy("remote", {
    min_start_interval_ms: 10,
    max_in_flight: 1
  });

  clock.advance(2999);
  await Promise.resolve();
  assert.equal(granted, false);

  clock.advance(1);
  const lease = await pending;
  assert.equal(granted, true);
  lease.release();
});

test("multi-key acquisition is atomic and never partially occupies a free key", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  for (const key of ["a", "b"]) {
    scheduler.set_policy(key, {
      min_start_interval_ms: 0,
      max_in_flight: 1
    });
  }

  const b = await scheduler.acquire({
    request_id: "hold-b",
    resource_keys: ["b"]
  });

  let multiGranted = false;
  const multi = scheduler.acquire({
    request_id: "multi",
    resource_keys: ["a", "b"]
  }).then((lease) => {
    multiGranted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(multiGranted, false);

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.resources.a.in_flight, 0);
  assert.equal(snapshot.resources.b.in_flight, 1);

  b.release();
  const lease = await multi;
  assert.equal(multiGranted, true);
  assert.equal(scheduler.snapshot().resources.a.in_flight, 1);
  assert.equal(scheduler.snapshot().resources.b.in_flight, 1);
  lease.release();
});

test("FIFO fairness keeps later requests behind the first waiting request", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  scheduler.set_policy("shared", {
    min_start_interval_ms: 0,
    max_in_flight: 1
  });

  const holder = await scheduler.acquire({
    request_id: "holder",
    resource_keys: ["shared"]
  });

  const order = [];
  const p1 = scheduler.acquire({
    request_id: "first",
    resource_keys: ["shared"]
  }).then((lease) => {
    order.push("first");
    return lease;
  });
  const p2 = scheduler.acquire({
    request_id: "second",
    resource_keys: ["shared"]
  }).then((lease) => {
    order.push("second");
    return lease;
  });

  holder.release();
  const first = await p1;
  assert.deepEqual(order, ["first"]);
  first.release();

  const second = await p2;
  assert.deepEqual(order, ["first", "second"]);
  second.release();
});

test("waiting reservations can be cancelled without consuming concurrency or budget", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  scheduler.set_policy("api", {
    min_start_interval_ms: 0,
    max_in_flight: 1,
    budget_limit: 10
  });

  const holder = await scheduler.acquire({
    request_id: "holder",
    resource_keys: ["api"],
    budget_costs: { api: 2 }
  });

  const waiting = scheduler.acquire({
    request_id: "waiting",
    resource_keys: ["api"],
    budget_costs: { api: 5 }
  });

  assert.equal(scheduler.cancel("waiting", "run stopped"), true);
  await assert.rejects(waiting, SchedulerCancelledError);

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.resources.api.in_flight, 1);
  assert.equal(snapshot.resources.api.budget_used, 2);
  holder.release();
});

test("window and budget limits are checked before a grant", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  scheduler.set_policy("provider", {
    min_start_interval_ms: 0,
    max_in_flight: 2,
    window_ms: 1000,
    max_starts_per_window: 2,
    budget_limit: 3
  });

  const one = await scheduler.acquire({
    request_id: "one",
    resource_keys: ["provider"],
    budget_costs: { provider: 1 }
  });
  one.release();
  const two = await scheduler.acquire({
    request_id: "two",
    resource_keys: ["provider"],
    budget_costs: { provider: 1 }
  });
  two.release();

  let thirdGranted = false;
  const third = scheduler.acquire({
    request_id: "three",
    resource_keys: ["provider"],
    budget_costs: { provider: 1 }
  }).then((lease) => {
    thirdGranted = true;
    return lease;
  });

  clock.advance(999);
  await Promise.resolve();
  assert.equal(thirdGranted, false);
  clock.advance(1);

  const lease = await third;
  assert.equal(thirdGranted, true);
  lease.release();

  const overBudget = scheduler.acquire({
    request_id: "four",
    resource_keys: ["provider"],
    budget_costs: { provider: 1 }
  });

  let settled = false;
  void overBudget.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  clock.advance(5000);
  await Promise.resolve();
  assert.equal(settled, false);
  scheduler.cancel("four", "budget exhausted");
  await assert.rejects(overBudget, SchedulerCancelledError);
});

test("delegated acquisition inherits already-held keys instead of deadlocking", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  scheduler.set_policy("network", {
    min_start_interval_ms: 0,
    max_in_flight: 1
  });
  scheduler.set_policy("child-only", {
    min_start_interval_ms: 0,
    max_in_flight: 1
  });

  const parent = await scheduler.acquire({
    request_id: "parent",
    resource_keys: ["network"]
  });

  const child = await scheduler.acquire({
    request_id: "child",
    resource_keys: ["network", "child-only"],
    inherit_lease_id: parent.id
  });

  assert.deepEqual(child.inherited_resource_keys, ["network"]);
  assert.deepEqual(child.resource_keys, ["child-only"]);

  parent.release();
  assert.equal(scheduler.snapshot().resources.network.in_flight, 1);

  child.release();
  assert.equal(scheduler.snapshot().resources.network.in_flight, 0);
  assert.equal(scheduler.snapshot().resources["child-only"].in_flight, 0);
});

test("snapshot and restore preserve remaining interval, budget and window history", async () => {
  const clock = new FakeClock();
  const scheduler = schedulerWith(clock);
  scheduler.set_policy("source", {
    min_start_interval_ms: 1000,
    max_in_flight: 1,
    window_ms: 5000,
    max_starts_per_window: 3,
    budget_limit: 10
  });

  const lease = await scheduler.acquire({
    request_id: "before",
    resource_keys: ["source"],
    budget_costs: { source: 4 }
  });
  lease.release();
  clock.advance(250);

  const saved = scheduler.snapshot();

  const restoredClock = new FakeClock();
  restoredClock.wall = clock.wall;
  const restored = schedulerWith(restoredClock);
  restored.restore(saved);

  const restoredSnapshot = restored.snapshot();
  assert.equal(restoredSnapshot.resources.source.budget_used, 4);
  assert.equal(restoredSnapshot.resources.source.start_times_epoch_ms.length, 1);

  let granted = false;
  const pending = restored.acquire({
    request_id: "after",
    resource_keys: ["source"],
    budget_costs: { source: 1 }
  }).then((next) => {
    granted = true;
    return next;
  });

  restoredClock.advance(749);
  await Promise.resolve();
  assert.equal(granted, false);
  restoredClock.advance(1);

  const next = await pending;
  assert.equal(granted, true);
  next.release();
});
