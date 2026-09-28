export interface SchedulerResourcePolicy {
  min_start_interval_ms: number;
  max_in_flight: number;
  window_ms?: number;
  max_starts_per_window?: number;
  budget_limit?: number;
}

export interface SchedulerAcquireRequest {
  request_id: string;
  resource_keys: string[];
  not_before_epoch_ms?: number;
  budget_costs?: Record<string, number>;
  inherit_lease_id?: string;
}

export interface SchedulerClock {
  monotonic_now_ms(): number;
  wall_now_ms(): number;
  set_timer(callback: () => void, delay_ms: number): unknown;
  clear_timer(handle: unknown): void;
}

export interface SchedulerResourceSnapshot {
  policy: SchedulerResourcePolicy;
  in_flight: number;
  budget_used: number;
  start_times_epoch_ms: number[];
  next_start_not_before_epoch_ms?: number;
}

export interface SchedulerSnapshot {
  schema_version: "0.1";
  kind: "shared-scheduler-state";
  captured_at_epoch_ms: number;
  resources: Record<string, SchedulerResourceSnapshot>;
}

export type SchedulerEvent =
  | {
      type: "policy_updated";
      resource_key: string;
      old_policy?: SchedulerResourcePolicy;
      new_policy: SchedulerResourcePolicy;
      applies_to: "not_started_requests";
    }
  | {
      type: "request_granted";
      request_id: string;
      lease_id: string;
      resource_keys: string[];
      inherited_resource_keys: string[];
    }
  | {
      type: "request_cancelled";
      request_id: string;
      reason: string;
    };

export interface SharedSchedulerOptions {
  clock?: SchedulerClock;
  on_event?: (event: SchedulerEvent) => void;
}

interface ResourceState {
  policy: SchedulerResourcePolicy;
  in_flight: number;
  budget_used: number;
  start_times_mono_ms: number[];
  last_start_mono_ms?: number;
  restored_not_before_mono_ms?: number;
}

interface PendingRequest {
  request: SchedulerAcquireRequest;
  resolve: (lease: SchedulerLease) => void;
  reject: (error: Error) => void;
}

interface ActiveLease {
  id: string;
  request_id: string;
  owned_keys: string[];
  inherited_keys: string[];
  inherited_from?: string;
  borrowers: number;
  release_requested: boolean;
  released: boolean;
}

export class SchedulerCancelledError extends Error {
  readonly code = "SCHEDULER_CANCELLED";

  constructor(message: string) {
    super(message);
    this.name = "SchedulerCancelledError";
  }
}

export class SchedulerLease {
  readonly id: string;
  readonly request_id: string;
  readonly resource_keys: readonly string[];
  readonly inherited_resource_keys: readonly string[];
  #release: () => void;
  #released = false;

  constructor(
    lease: ActiveLease,
    release: () => void
  ) {
    this.id = lease.id;
    this.request_id = lease.request_id;
    this.resource_keys = [...lease.owned_keys];
    this.inherited_resource_keys = [...lease.inherited_keys];
    this.#release = release;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#release();
  }
}

class SystemSchedulerClock implements SchedulerClock {
  monotonic_now_ms(): number {
    return performance.now();
  }

  wall_now_ms(): number {
    return Date.now();
  }

  set_timer(callback: () => void, delay_ms: number): unknown {
    return setTimeout(callback, delay_ms);
  }

  clear_timer(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

function clonePolicy(policy: SchedulerResourcePolicy): SchedulerResourcePolicy {
  return {
    min_start_interval_ms: policy.min_start_interval_ms,
    max_in_flight: policy.max_in_flight,
    ...(policy.window_ms === undefined ? {} : { window_ms: policy.window_ms }),
    ...(policy.max_starts_per_window === undefined
      ? {}
      : { max_starts_per_window: policy.max_starts_per_window }),
    ...(policy.budget_limit === undefined
      ? {}
      : { budget_limit: policy.budget_limit })
  };
}

function validatePolicy(policy: SchedulerResourcePolicy): void {
  if (
    !Number.isFinite(policy.min_start_interval_ms) ||
    policy.min_start_interval_ms < 0
  ) {
    throw new RangeError("min_start_interval_ms must be a finite non-negative number");
  }

  if (
    !Number.isInteger(policy.max_in_flight) ||
    policy.max_in_flight < 1
  ) {
    throw new RangeError("max_in_flight must be an integer >= 1");
  }

  const hasWindow = policy.window_ms !== undefined;
  const hasWindowLimit = policy.max_starts_per_window !== undefined;
  if (hasWindow !== hasWindowLimit) {
    throw new RangeError(
      "window_ms and max_starts_per_window must be configured together"
    );
  }

  if (
    policy.window_ms !== undefined &&
    (!Number.isFinite(policy.window_ms) || policy.window_ms <= 0)
  ) {
    throw new RangeError("window_ms must be a finite positive number");
  }

  if (
    policy.max_starts_per_window !== undefined &&
    (!Number.isInteger(policy.max_starts_per_window) ||
      policy.max_starts_per_window < 1)
  ) {
    throw new RangeError("max_starts_per_window must be an integer >= 1");
  }

  if (
    policy.budget_limit !== undefined &&
    (!Number.isFinite(policy.budget_limit) || policy.budget_limit < 0)
  ) {
    throw new RangeError("budget_limit must be a finite non-negative number");
  }
}

function uniqueKeys(keys: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const key of keys) {
    if (key.length === 0) throw new RangeError("resource key must not be empty");
    if (unique.has(key)) {
      throw new RangeError(`duplicate resource key: ${key}`);
    }
    unique.add(key);
  }
  return [...unique].sort();
}

function budgetCost(request: SchedulerAcquireRequest, key: string): number {
  const cost = request.budget_costs?.[key] ?? 0;
  if (!Number.isFinite(cost) || cost < 0) {
    throw new RangeError(`budget cost for ${key} must be finite and non-negative`);
  }
  return cost;
}

export class SharedScheduler {
  readonly #clock: SchedulerClock;
  readonly #onEvent: ((event: SchedulerEvent) => void) | undefined;
  readonly #resources = new Map<string, ResourceState>();
  readonly #pending: PendingRequest[] = [];
  readonly #pendingById = new Map<string, PendingRequest>();
  readonly #activeLeases = new Map<string, ActiveLease>();
  #nextLease = 1;
  #timer: unknown | undefined;
  #closed = false;

  constructor(options: SharedSchedulerOptions = {}) {
    this.#clock = options.clock ?? new SystemSchedulerClock();
    this.#onEvent = options.on_event;
  }

  set_policy(resource_key: string, policy: SchedulerResourcePolicy): void {
    if (resource_key.length === 0) {
      throw new RangeError("resource key must not be empty");
    }
    validatePolicy(policy);

    const existing = this.#resources.get(resource_key);
    const oldPolicy = existing === undefined
      ? undefined
      : clonePolicy(existing.policy);

    if (existing) {
      existing.policy = clonePolicy(policy);
    } else {
      this.#resources.set(resource_key, {
        policy: clonePolicy(policy),
        in_flight: 0,
        budget_used: 0,
        start_times_mono_ms: []
      });
    }

    this.#onEvent?.({
      type: "policy_updated",
      resource_key,
      ...(oldPolicy === undefined ? {} : { old_policy: oldPolicy }),
      new_policy: clonePolicy(policy),
      applies_to: "not_started_requests"
    });

    this.#drain();
  }

  get_policy(resource_key: string): SchedulerResourcePolicy | undefined {
    const state = this.#resources.get(resource_key);
    return state === undefined ? undefined : clonePolicy(state.policy);
  }

  acquire(request: SchedulerAcquireRequest): Promise<SchedulerLease> {
    if (this.#closed) {
      return Promise.reject(
        new SchedulerCancelledError("scheduler is closed")
      );
    }
    if (this.#pendingById.has(request.request_id)) {
      return Promise.reject(
        new Error(`duplicate scheduler request_id: ${request.request_id}`)
      );
    }

    const keys = uniqueKeys(request.resource_keys);
    if (keys.length === 0) {
      return Promise.reject(new RangeError("at least one resource key is required"));
    }

    for (const key of keys) {
      if (!this.#resources.has(key)) {
        return Promise.reject(new Error(`resource policy not configured: ${key}`));
      }
      budgetCost(request, key);
    }

    if (
      request.not_before_epoch_ms !== undefined &&
      !Number.isFinite(request.not_before_epoch_ms)
    ) {
      return Promise.reject(
        new RangeError("not_before_epoch_ms must be finite")
      );
    }

    if (
      request.inherit_lease_id !== undefined &&
      !this.#activeLeases.has(request.inherit_lease_id)
    ) {
      return Promise.reject(
        new Error(`inherited lease is not active: ${request.inherit_lease_id}`)
      );
    }

    const normalized: SchedulerAcquireRequest = {
      ...request,
      resource_keys: keys,
      ...(request.budget_costs === undefined
        ? {}
        : { budget_costs: { ...request.budget_costs } })
    };

    return new Promise<SchedulerLease>((resolve, reject) => {
      const pending = { request: normalized, resolve, reject };
      this.#pending.push(pending);
      this.#pendingById.set(normalized.request_id, pending);
      this.#drain();
    });
  }

  cancel(request_id: string, reason = "cancelled"): boolean {
    const pending = this.#pendingById.get(request_id);
    if (!pending) return false;

    const index = this.#pending.indexOf(pending);
    if (index >= 0) this.#pending.splice(index, 1);
    this.#pendingById.delete(request_id);
    pending.reject(new SchedulerCancelledError(reason));
    this.#onEvent?.({
      type: "request_cancelled",
      request_id,
      reason
    });
    this.#drain();
    return true;
  }

  close(reason = "scheduler closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();

    for (const pending of this.#pending.splice(0)) {
      this.#pendingById.delete(pending.request.request_id);
      pending.reject(new SchedulerCancelledError(reason));
      this.#onEvent?.({
        type: "request_cancelled",
        request_id: pending.request.request_id,
        reason
      });
    }
  }

  snapshot(): SchedulerSnapshot {
    const monoNow = this.#clock.monotonic_now_ms();
    const wallNow = this.#clock.wall_now_ms();
    const resources: Record<string, SchedulerResourceSnapshot> = {};

    for (const [key, state] of this.#resources) {
      this.#pruneHistory(state, monoNow);

      const startTimesEpoch = state.start_times_mono_ms.map(
        (start) => wallNow - Math.max(0, monoNow - start)
      );

      let nextStartNotBefore: number | undefined;
      if (state.last_start_mono_ms !== undefined) {
        const remaining = Math.max(
          0,
          state.last_start_mono_ms +
            state.policy.min_start_interval_ms -
            monoNow
        );
        nextStartNotBefore = wallNow + remaining;
      }
      if (state.restored_not_before_mono_ms !== undefined) {
        const remaining = Math.max(
          0,
          state.restored_not_before_mono_ms - monoNow
        );
        const restoredEpoch = wallNow + remaining;
        nextStartNotBefore = Math.max(
          nextStartNotBefore ?? 0,
          restoredEpoch
        );
      }

      resources[key] = {
        policy: clonePolicy(state.policy),
        in_flight: state.in_flight,
        budget_used: state.budget_used,
        start_times_epoch_ms: startTimesEpoch,
        ...(nextStartNotBefore === undefined
          ? {}
          : { next_start_not_before_epoch_ms: nextStartNotBefore })
      };
    }

    return {
      schema_version: "0.1",
      kind: "shared-scheduler-state",
      captured_at_epoch_ms: wallNow,
      resources
    };
  }

  restore(snapshot: SchedulerSnapshot): void {
    if (
      snapshot.schema_version !== "0.1" ||
      snapshot.kind !== "shared-scheduler-state"
    ) {
      throw new Error("unsupported scheduler snapshot");
    }
    if (this.#pending.length > 0 || this.#activeLeases.size > 0) {
      throw new Error("scheduler state can only be restored while idle");
    }

    const monoNow = this.#clock.monotonic_now_ms();
    const wallNow = this.#clock.wall_now_ms();
    this.#resources.clear();

    for (const [key, saved] of Object.entries(snapshot.resources)) {
      validatePolicy(saved.policy);

      const history = saved.start_times_epoch_ms.map((epoch) => {
        const elapsed = Math.max(0, wallNow - epoch);
        return monoNow - elapsed;
      });

      const remaining =
        saved.next_start_not_before_epoch_ms === undefined
          ? undefined
          : Math.max(
              0,
              saved.next_start_not_before_epoch_ms - wallNow
            );

      this.#resources.set(key, {
        policy: clonePolicy(saved.policy),
        in_flight: saved.in_flight,
        budget_used: saved.budget_used,
        start_times_mono_ms: history,
        ...(history.length === 0
          ? {}
          : { last_start_mono_ms: Math.max(...history) }),
        ...(remaining === undefined
          ? {}
          : { restored_not_before_mono_ms: monoNow + remaining })
      });
    }
  }

  #drain(): void {
    if (this.#closed) return;
    this.#clearTimer();

    while (this.#pending.length > 0) {
      const pending = this.#pending[0];
      if (pending === undefined) break;

      const wait = this.#waitFor(pending.request);
      if (wait > 0) {
        this.#armTimer(wait);
        return;
      }

      if (!this.#canAcquire(pending.request)) {
        return;
      }

      this.#pending.shift();
      this.#pendingById.delete(pending.request.request_id);
      this.#grant(pending);
    }
  }

  #waitFor(request: SchedulerAcquireRequest): number {
    const monoNow = this.#clock.monotonic_now_ms();
    const wallNow = this.#clock.wall_now_ms();
    let wait = Math.max(
      0,
      (request.not_before_epoch_ms ?? wallNow) - wallNow
    );

    const inherited = request.inherit_lease_id === undefined
      ? undefined
      : this.#activeLeases.get(request.inherit_lease_id);
    const inheritedKeys = new Set(inherited?.owned_keys ?? []);

    for (const key of request.resource_keys) {
      if (inheritedKeys.has(key)) continue;
      const state = this.#resources.get(key);
      if (!state) continue;
      this.#pruneHistory(state, monoNow);

      if (state.last_start_mono_ms !== undefined) {
        wait = Math.max(
          wait,
          state.last_start_mono_ms +
            state.policy.min_start_interval_ms -
            monoNow
        );
      }

      if (state.restored_not_before_mono_ms !== undefined) {
        wait = Math.max(
          wait,
          state.restored_not_before_mono_ms - monoNow
        );
      }

      const { window_ms: windowMs, max_starts_per_window: maxStarts } =
        state.policy;
      if (
        windowMs !== undefined &&
        maxStarts !== undefined &&
        state.start_times_mono_ms.length >= maxStarts
      ) {
        const oldest = state.start_times_mono_ms[0];
        if (oldest !== undefined) {
          wait = Math.max(wait, oldest + windowMs - monoNow);
        }
      }
    }

    return Math.max(0, wait);
  }

  #canAcquire(request: SchedulerAcquireRequest): boolean {
    const inherited = request.inherit_lease_id === undefined
      ? undefined
      : this.#activeLeases.get(request.inherit_lease_id);
    if (request.inherit_lease_id !== undefined && !inherited) return false;

    const inheritedKeys = new Set(inherited?.owned_keys ?? []);

    for (const key of request.resource_keys) {
      if (inheritedKeys.has(key)) continue;
      const state = this.#resources.get(key);
      if (!state) return false;

      if (state.in_flight >= state.policy.max_in_flight) return false;

      const limit = state.policy.budget_limit;
      const cost = budgetCost(request, key);
      if (limit !== undefined && state.budget_used + cost > limit) {
        return false;
      }
    }

    return true;
  }

  #grant(pending: PendingRequest): void {
    const request = pending.request;
    const monoNow = this.#clock.monotonic_now_ms();
    const inherited = request.inherit_lease_id === undefined
      ? undefined
      : this.#activeLeases.get(request.inherit_lease_id);
    const inheritedKeys = new Set(inherited?.owned_keys ?? []);
    const ownedKeys: string[] = [];
    const borrowedKeys: string[] = [];

    for (const key of request.resource_keys) {
      if (inheritedKeys.has(key)) {
        borrowedKeys.push(key);
        continue;
      }

      const state = this.#resources.get(key);
      if (!state) {
        throw new Error(`resource disappeared while granting: ${key}`);
      }

      state.in_flight += 1;
      state.budget_used += budgetCost(request, key);
      state.last_start_mono_ms = monoNow;
      delete state.restored_not_before_mono_ms;
      state.start_times_mono_ms.push(monoNow);
      this.#pruneHistory(state, monoNow);
      ownedKeys.push(key);
    }

    const leaseId = `lease-${this.#nextLease++}`;
    const active: ActiveLease = {
      id: leaseId,
      request_id: request.request_id,
      owned_keys: ownedKeys,
      inherited_keys: borrowedKeys,
      ...(inherited === undefined ? {} : { inherited_from: inherited.id }),
      borrowers: 0,
      release_requested: false,
      released: false
    };

    if (inherited) inherited.borrowers += 1;
    this.#activeLeases.set(leaseId, active);

    this.#onEvent?.({
      type: "request_granted",
      request_id: request.request_id,
      lease_id: leaseId,
      resource_keys: [...ownedKeys],
      inherited_resource_keys: [...borrowedKeys]
    });

    pending.resolve(
      new SchedulerLease(active, () => this.#releaseLease(leaseId))
    );
  }

  #releaseLease(leaseId: string): void {
    const lease = this.#activeLeases.get(leaseId);
    if (!lease || lease.released) return;

    if (lease.borrowers > 0) {
      lease.release_requested = true;
      return;
    }

    this.#finalizeRelease(lease);
    this.#drain();
  }

  #finalizeRelease(lease: ActiveLease): void {
    if (lease.released) return;
    lease.released = true;
    this.#activeLeases.delete(lease.id);

    for (const key of lease.owned_keys) {
      const state = this.#resources.get(key);
      if (state) state.in_flight = Math.max(0, state.in_flight - 1);
    }

    if (lease.inherited_from !== undefined) {
      const parent = this.#activeLeases.get(lease.inherited_from);
      if (parent) {
        parent.borrowers = Math.max(0, parent.borrowers - 1);
        if (parent.release_requested && parent.borrowers === 0) {
          this.#finalizeRelease(parent);
        }
      }
    }
  }

  #pruneHistory(state: ResourceState, now: number): void {
    const windowMs = state.policy.window_ms;
    if (windowMs === undefined) {
      if (state.start_times_mono_ms.length > 1) {
        state.start_times_mono_ms = [
          state.start_times_mono_ms[state.start_times_mono_ms.length - 1]!
        ];
      }
      return;
    }

    const cutoff = now - windowMs;
    while (
      state.start_times_mono_ms.length > 0 &&
      state.start_times_mono_ms[0]! <= cutoff
    ) {
      state.start_times_mono_ms.shift();
    }
  }

  #armTimer(delayMs: number): void {
    const delay = Math.max(0, Math.ceil(delayMs));
    this.#timer = this.#clock.set_timer(() => {
      this.#timer = undefined;
      this.#drain();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#clock.clear_timer(this.#timer);
    this.#timer = undefined;
  }
}
