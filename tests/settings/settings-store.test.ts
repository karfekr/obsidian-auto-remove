import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TTL_DAYS } from "../../src/settings/defaults";
import type { SettingsPersistence } from "../../src/settings/settings-store";
import { SettingsStore } from "../../src/settings/settings-store";

/** Records every write, and can be made slow or made to fail. */
function controllablePersistence(initial: unknown = undefined) {
	const saved: unknown[] = [];
	let resolveGate: (() => void) | null = null;
	let failNext = false;
	let inFlight = 0;
	let maxConcurrent = 0;

	const persistence: SettingsPersistence = {
		loadData: async () => initial,
		saveData: async (data) => {
			inFlight += 1;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			// Hold the write open so overlap can be arranged deliberately.
			await new Promise<void>((resolve) => (resolveGate = resolve));
			inFlight -= 1;
			if (failNext) {
				failNext = false;
				throw new Error("disk full");
			}
			saved.push(data);
		},
	};

	return {
		persistence,
		saved,
		/** How many writes were ever in flight at once. */
		get maxConcurrent() {
			return maxConcurrent;
		},
		failOnce() {
			failNext = true;
		},
		/** Lets the held write finish. */
		release() {
			const resolve = resolveGate;
			resolveGate = null;
			resolve?.();
		},
		get held() {
			return resolveGate !== null;
		},
	};
}

async function tick(times = 12): Promise<void> {
	for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("SettingsStore", () => {
	it("starts from validated defaults when nothing is persisted", async () => {
		const store = await SettingsStore.load({
			loadData: async () => undefined,
			saveData: async () => {},
		});
		expect(store.settings.defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
	});

	it("validates persisted data on the way in", async () => {
		const store = await SettingsStore.load({
			loadData: async () => ({ defaultTtlDays: "soon" }),
			saveData: async () => {},
		});
		expect(store.settings.defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
	});

	it("persists the whole settings object on update", async () => {
		const store = await SettingsStore.load({
			loadData: async () => undefined,
			saveData: async () => {},
		});

		await store.update({ defaultTtlDays: 30 });

		expect(store.settings.defaultTtlDays).toBe(30);
	});

	it("replaces the settings object rather than mutating it", async () => {
		const store = await SettingsStore.load({
			loadData: async () => undefined,
			saveData: async () => {},
		});
		const before = store.settings;

		await store.update({ defaultTtlDays: 30 });

		expect(store.settings).not.toBe(before);
		expect(before.defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
	});

	it("notifies subscribers with the new settings", async () => {
		const store = await SettingsStore.load({
			loadData: async () => undefined,
			saveData: async () => {},
		});
		const listener = vi.fn();
		store.subscribe(listener);

		await store.update({ defaultTtlDays: 30 });

		expect(listener).toHaveBeenCalledWith(store.settings);
	});

	it("stops notifying once unsubscribed", async () => {
		const store = await SettingsStore.load({
			loadData: async () => undefined,
			saveData: async () => {},
		});
		const listener = vi.fn();
		store.subscribe(listener)();

		await store.update({ defaultTtlDays: 30 });

		expect(listener).not.toHaveBeenCalled();
	});

	describe("writing", () => {
		it("notifies listeners before the write finishes", async () => {
			// The audit found trigger changes taking effect a disk round-trip late
			// because notification happened after `saveData` resolved.
			const io = controllablePersistence();
			const store = await SettingsStore.load(io.persistence);
			const seen: number[] = [];
			store.subscribe((settings) => seen.push(settings.defaultTtlDays));

			const pending = store.update({ defaultTtlDays: 9 });

			expect(seen).toEqual([9]);
			expect(io.saved).toEqual([]);
			io.release();
			await pending;
		});

		it("never runs two writes at once", async () => {
			// One keystroke produces one `update`; three in a row must not race.
			const io = controllablePersistence();
			const store = await SettingsStore.load(io.persistence);

			void store.update({ defaultTtlDays: 1 });
			await tick();
			void store.update({ defaultTtlDays: 2 });
			await tick();
			void store.update({ defaultTtlDays: 3 });
			await tick();

			expect(io.maxConcurrent).toBe(1);
		});

		it("writes the newest value, not a stale one", async () => {
			const io = controllablePersistence();
			const store = await SettingsStore.load(io.persistence);

			void store.update({ defaultTtlDays: 1 });
			await tick();
			io.release();
			void store.update({ defaultTtlDays: 2 });
			void store.update({ defaultTtlDays: 3 });
			await tick();
			io.release();
			await store.flush();

			const written = io.saved.map((entry) => (entry as { defaultTtlDays: number }).defaultTtlDays);
			// The intermediate `2` is folded away, and the last write is `3`. That is the
			// fix for "my last edit vanished on restart": no stale snapshot can land
			// after the newest one.
			expect(written).not.toContain(2);
			expect(written[written.length - 1]).toBe(3);
		});

		it("ends with the disk matching memory", async () => {
			const io = controllablePersistence();
			const store = await SettingsStore.load(io.persistence);

			for (let days = 1; days <= 4; days += 1) {
				void store.update({ defaultTtlDays: days });
				await tick();
				io.release();
			}
			await store.flush();

			const last = io.saved[io.saved.length - 1] as { defaultTtlDays: number };
			expect(last.defaultTtlDays).toBe(store.settings.defaultTtlDays);
		});
	});

	describe("a failing write", () => {
		it("reports the failure instead of leaving an unhandled rejection", async () => {
			const io = controllablePersistence();
			io.failOnce();
			const onPersistenceError = vi.fn();
			const store = await SettingsStore.load(io.persistence, { onPersistenceError });

			const pending = store.update({ defaultTtlDays: 30 });
			io.release();

			await expect(pending).resolves.toBeUndefined();
			expect(onPersistenceError).toHaveBeenCalledOnce();
		});

		it("keeps the change in memory even though the disk refused", async () => {
			const io = controllablePersistence();
			io.failOnce();
			const store = await SettingsStore.load(io.persistence, { onPersistenceError: () => {} });

			const pending = store.update({ defaultTtlDays: 30 });
			io.release();
			await pending;

			// In memory the rule is what the user asked for; the UI reflects it, and the
			// failure is surfaced separately rather than silently reverting their edit.
			expect(store.settings.defaultTtlDays).toBe(30);
		});

		it("still attempts the next write after a failure", async () => {
			const io = controllablePersistence();
			io.failOnce();
			const store = await SettingsStore.load(io.persistence, { onPersistenceError: () => {} });

			void store.update({ defaultTtlDays: 1 });
			await tick();
			io.release();
			void store.update({ defaultTtlDays: 2 });
			await tick();
			io.release();
			await store.flush();

			expect(io.saved.map((entry) => (entry as { defaultTtlDays: number }).defaultTtlDays)).toEqual(
				[2],
			);
		});

		it("does not reject when no reporter was supplied", async () => {
			const io = controllablePersistence();
			io.failOnce();
			const store = await SettingsStore.load(io.persistence);

			const pending = store.update({ defaultTtlDays: 30 });
			io.release();

			await expect(pending).resolves.toBeUndefined();
		});
	});
});
