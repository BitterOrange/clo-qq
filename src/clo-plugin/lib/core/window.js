// Per-group serial queues. The addressed lane drains before a flushed window, and each lane has its
// own cap, so a flood of ordinary messages can never crowd out a real @. Nor can queued names: a task that
// yields takes no room from one that does not.
//
// Urgent work gets a little room of its own, so a full lane does not refuse it, and urgentKey limits how much of that
// room one sender holds, so one person repeating themselves does not refuse another. Neither changes the order.
// The same allowance limits how many of a sender's lines move a window up, but a line that fitted in chat room took
// nothing from anyone, so it does not cost the sender an extra place in the addressed lane.
export function createGroupQueues({
  windowMs, maxPending, maxConcurrentTurns,
  setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {}, onDrop = () => {}, isUrgent = () => false,
  urgentKey = () => null, urgentExtra = 3, urgentPerSender = 2,
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
      g = { key, addressed: [], flushed: [], open: null, windowPending: 0, urgentPending: 0, addressedExtra: 0, heldBySender: new Map(), pastCapBySender: new Map(), running: false, queued: false };
      groups.set(key, g);
    }
    return g;
  }

  // A record whose sender cannot be told apart has no allowance to run out of.
  const senderHasRoom = (counts, key) => key == null || (counts.get(key) ?? 0) < urgentPerSender;

  function hold(counts, key) {
    if (key != null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  function release(counts, key) {
    if (key == null) return;
    const left = counts.get(key) - 1;
    if (left > 0) counts.set(key, left);
    else counts.delete(key);
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
        for (const key of item.holders) release(g.heldBySender, key);
        for (const key of item.pastCap) release(g.pastCapBySender, key);
      } else if (item.extra) {
        g.addressedExtra -= 1;
        release(g.heldBySender, item.holder);
        release(g.pastCapBySender, item.holder);
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
    const { records, onFlush, urgent, holders, pastCap } = w;
    g.flushed.push({ records, run: () => onFlush(records), urgent, holders, pastCap });
    schedule(g);
    settleWaiters();
  }

  return {
    // A yielding task stays behind every task that is not, whenever that one arrives, so those sit first and `firm`
    // counts them. A task that does not yield counts only those; one that yields counts the whole lane.
    // Urgent work never yields. It queues like any other task while there is room, and past that takes one of the extra
    // places, which are not counted against later tasks. A sender's limit here counts only room past a cap.
    addressed(groupKey, task, record, { yielding: asked = false, urgent = false } = {}) {
      if (stopped) return { ok: false, reason: 'stopped' };
      const g = groupOf(groupKey);
      const before = g.addressed.findIndex((i) => i.yielding);
      const firm = before < 0 ? g.addressed.length : before;
      const yielding = asked && !urgent;
      let extra = false;
      let holder = null;
      if ((yielding ? g.addressed.length : firm - g.addressedExtra) >= maxPending) {
        if (urgent) holder = urgentKey(record);
        if (!urgent || g.addressedExtra >= urgentExtra || !senderHasRoom(g.pastCapBySender, holder)) return { ok: false, reason: 'queue_full' };
        extra = true;
        g.addressedExtra += 1;
        hold(g.heldBySender, holder);
        hold(g.pastCapBySender, holder);
      }
      g.addressed.splice(yielding ? g.addressed.length : firm, 0, { run: task, record, yielding, extra, holder });
      schedule(g);
      return { ok: true };
    },

    // Chat cannot shut out what is urgent: such a record counts against the chat cap, but only its own kind refuses it.
    // Past the sender's allowance a record is plain chat here, so it needs chat room and does not move its window up.
    ordinary(groupKey, record, onFlush) {
      if (stopped) return { ok: false, reason: 'stopped' };
      const g = groupOf(groupKey);
      const flagged = isUrgent([record]);
      const holder = flagged ? urgentKey(record) : null;
      const urgent = flagged && senderHasRoom(g.heldBySender, holder);
      if ((urgent ? g.urgentPending : g.windowPending) >= maxPending) return { ok: false, reason: 'queue_full' };
      const pastCap = g.windowPending >= maxPending;
      g.windowPending += 1;
      if (urgent) {
        g.urgentPending += 1;
        hold(g.heldBySender, holder);
        if (pastCap) hold(g.pastCapBySender, holder);
      }
      if (!g.open) {
        const w = { records: [], onFlush, timer: null, urgent: 0, holders: [], pastCap: [] };
        w.timer = setTimer(() => closeWindow(g), windowMs);
        w.timer?.unref?.();
        g.open = w;
      }
      g.open.records.push(record);
      if (urgent) {
        g.open.urgent += 1;
        if (holder != null) {
          g.open.holders.push(holder);
          if (pastCap) g.open.pastCap.push(holder);
        }
      }
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
        g.addressedExtra = 0;
        g.heldBySender.clear();
        g.pastCapBySender.clear();
      }
      settleWaiters();
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => stopWaiters.push(resolve));
    },
  };
}
