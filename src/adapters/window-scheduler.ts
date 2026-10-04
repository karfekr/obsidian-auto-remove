import type { Scheduler } from "../services/ports";

/**
 * {@link Scheduler} on top of the browser timers.
 *
 * Every timer is handed to `register` as it is created, so unloading the plugin
 * cancels all of them. Nothing here is stored on the plugin instance and nothing
 * has to be torn down by hand — the failure the audit described, where a listener
 * outlived the plugin that made it, is structurally impossible for a timer.
 */
export class WindowScheduler implements Scheduler {
  constructor(private readonly register: (cancel: () => void) => void) {}

  every(ms: number, fn: () => void): () => void {
    const id = window.setInterval(fn, ms);
    return this.track(() => window.clearInterval(id));
  }

  after(ms: number, fn: () => void): () => void {
    const id = window.setTimeout(fn, ms);
    return this.track(() => window.clearTimeout(id));
  }

  private track(cancel: () => void): () => void {
    this.register(cancel);
    return () => {
      cancel();
    };
  }
}
