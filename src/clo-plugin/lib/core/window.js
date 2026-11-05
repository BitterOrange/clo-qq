// Per-group serial queues. The addressed lane drains before a flushed window, and each lane has its
// own cap, so a flood of ordinary messages can never crowd out a real @. Nor can queued names: a task that
// yields takes no room from one that does not.
export function createGroupQueues({
  windowMs, maxPending, maxConcurrentTurns,
  setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {}, onDrop = () => {}, isUrgent = () => false,
}) {
  const groups = new Map();
  const ready = [];
  let active = 0;
  let stopped = false;
  let idleWaiters = [];
  let stopWaiters = [];

  function groupOf(key) {
    let g = groups.get(key);
    if (!g) {
      g = { key, addressed: [], flushed: [], open: null, windowPending: 0, urgentPending: 0, running: false, queued: false };
      groups.set(key, g);
    }
    return g;
  }

  const hasWork = (g) => g.addressed.length > 0 || g.flushed.length > 0;
  const busy = () => active > 0 || ready.length > 0 || [...groups.values()].some((g) => g.running || hasWork(g) || g.open);

  function settleWaiters() {
    if (busy()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  function schedule(g) {
    if (!g.running && !g.queued && hasWork(g)) {
      g.queued = true;
      ready.push(g);
    }
    pump();
  }

  // An urgent window does not wait behind yielding tasks, and ordinary windows still cannot pass them.
  function takeNext(g) {
    if (!g.addressed[0] || g.addressed[0].yielding) {
      const urgent = g.flushed.findIndex((i) => i.urgent);
      if (urgent >= 0) return g.flushed.splice(urgent, 1)[0];
    }
    return g.addressed.shift() ?? g.flushed.shift();
  }

  function pump() {
    while (!stopped && active < maxConcurrentTurns && ready.length > 0) {
      const g = ready.shift();
      g.queued = false;
      const item = takeNext(g);
      if (!item) continue;
      g.running = true;
      active += 1;
      if (item.records) {
        g.windowPending -= item.records.length;
        g.urgentPending -= item.urgent;
      }
      Promise.resolve()
        .then(item.run)
        .catch(onError)
        .finally(() => {
          active -= 1;
          g.running = false;
          if (active === 0) {
            const waiters = stopWaiters;
            stopWaiters = [];
            for (const w of waiters) w();
          }
          schedule(g);
          settleWaiters();
        });
    }
  }

  function closeWindow(g) {
    const w = g.open;
    if (!w) return;
    g.open = null;
    const { records, onFlush, urgent } = w;
    g.flushed.push({ records, run: () => onFlush(records), urgent });
    schedule(g);
    settleWaiters();
  }

  return {
    // A yielding task stays behind every task that is not, whenever that one arrives, so those sit first and `firm`
    // counts them. A task that does not yield counts only those; one that yields counts the whole lane.
    addressed(groupKey, task, record, { yielding = false } = {}) {
      if (stopped) return { ok: false, reason: 'stopped' };
      const g = groupOf(groupKey);
      const before = g.addressed.findIndex((i) => i.yielding);
      const firm = before < 0 ? g.addressed.length : before;
      if ((yielding ? g.addressed.length : firm) >= maxPending) return { ok: false, reason: 'queue_full' };
      g.addressed.splice(yielding ? g.addressed.length : firm, 0, { run: task, record, yielding });
      schedule(g);
      return { ok: true };
    },

    // Chat cannot shut out what is urgent: such a record counts against the chat cap, but only its own kind refuses it.
    ordinary(groupKey, record, onFlush) {
      if (stopped) return { ok: false, reason: 'stopped' };
      const g = groupOf(groupKey);
      const urgent = isUrgent([record]);
      if ((urgent ? g.urgentPending : g.windowPending) >= maxPending) return { ok: false, reason: 'queue_full' };
      g.windowPending += 1;
      if (urgent) g.urgentPending += 1;
      if (!g.open) {
        const w = { records: [], onFlush, timer: null, urgent: 0 };
        w.timer = setTimer(() => closeWindow(g), windowMs);
        w.timer?.unref?.();
        g.open = w;
      }
      g.open.records.push(record);
      if (urgent) g.open.urgent += 1;
      return { ok: true };
    },

    idle() {
      if (!busy()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    // Pending work is handed to onDrop. Resolves once running tasks have ended.
    stop() {
      stopped = true;
      ready.length = 0;
      for (const g of groups.values()) {
        g.queued = false;
        if (g.open) {
          clearTimer(g.open.timer);
          for (const r of g.open.records) onDrop(r);
          g.open = null;
        }
        for (const item of g.addressed) if (item.record) onDrop(item.record);
        for (const item of g.flushed) for (const r of item.records) onDrop(r);
        g.addressed = [];
        g.flushed = [];
        g.windowPending = 0;
        g.urgentPending = 0;
      }
      settleWaiters();
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => stopWaiters.push(resolve));
    },
  };
}
