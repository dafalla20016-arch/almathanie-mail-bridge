// Server-side scheduler. Credentials stay in environment variables, never logs.
export function startPushDispatcher({
  env = process.env, fetchImpl = fetch, log = console,
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if (env.PUSH_ENABLED !== 'true') return { stop() {} };
  let origin;
  try {
    origin = new URL(env.PUSH_SITE_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    if (!env.PUSH_DISPATCH_SECRET || env.PUSH_DISPATCH_SECRET.length < 32) throw new Error();
  } catch {
    log.error('Push disabled: check PUSH_SITE_ORIGIN and PUSH_DISPATCH_SECRET');
    return { stop() {} };
  }
  const endpoint = new URL('/api/push/tick', origin);
  let stopped = false, timer, controller, timeout;
  async function tick() {
    if (stopped) return;
    controller = new AbortController();
    timeout = schedule(() => controller.abort(), 110000);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${env.PUSH_DISPATCH_SECRET}` },
        signal: controller.signal,
      });
      if (response.status === 202) {
        log.info('Push check: another runner is active');
      } else if (!response.ok) {
        log.error(`Push check failed: HTTP ${response.status}`);
      } else {
        const result = await response.json();
        if (result.ok === true) log.info('Push check completed');
        else log.error('Push check failed: unexpected response');
      }
    } catch {
      if (!stopped) log.error('Push check unavailable; will retry');
    } finally {
      cancel(timeout);
      controller = undefined;
      // Schedule only after completion; no overlapping local requests.
      if (!stopped) timer = schedule(tick, 15000);
    }
  }
  log.info('Push scheduler enabled');
  timer = schedule(tick, 5000);
  return { stop() { stopped = true; cancel(timer); cancel(timeout); controller?.abort(); } };
}
