import { describe, expect, it } from 'vitest';
import { waitWindowMs } from '../nodes/Ratifia/Ratifia.node';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const mins = (n: number) => n * 60_000;
const expiresIn = (m: number) => NOW + mins(m);

describe('how long the node waits', () => {
	// The bug: a 4h policy expiry against a flat 60m wait. The node gave up, the
	// decision stayed PENDING, and the verdict arrived with nothing listening.
	it('follows a policy expiry longer than the old flat hour', () => {
		const ms = waitWindowMs({ expiresAtMs: expiresIn(240), intervalSec: 15, now: NOW });
		expect(ms).toBeGreaterThan(mins(60));
		expect(ms).toBeCloseTo(mins(240) + 15_000, -3);
	});

	it('stops at a short expiry instead of polling for an hour', () => {
		expect(waitWindowMs({ expiresAtMs: expiresIn(15), intervalSec: 15, now: NOW })).toBeCloseTo(
			mins(15) + 15_000,
			-3
		);
	});

	it('adds one interval of grace, so the last poll sees EXPIRED', () => {
		const ms = waitWindowMs({ expiresAtMs: expiresIn(10), intervalSec: 30, now: NOW });
		expect(ms).toBe(mins(10) + 30_000);
	});

	it('falls back to an hour when the decision never expires', () => {
		expect(waitWindowMs({ expiresAtMs: Number.NaN, intervalSec: 15, now: NOW })).toBe(mins(60));
	});

	it('honours an explicit cap that is shorter than the expiry', () => {
		expect(
			waitWindowMs({ expiresAtMs: expiresIn(240), intervalSec: 15, maxWaitMinutes: 30, now: NOW })
		).toBe(mins(30));
	});

	it('never waits past the expiry, even when the cap is longer', () => {
		const ms = waitWindowMs({ expiresAtMs: expiresIn(10), intervalSec: 15, maxWaitMinutes: 600, now: NOW });
		expect(ms).toBeCloseTo(mins(10) + 15_000, -3);
	});

	it('still polls once when the expiry has already passed', () => {
		expect(waitWindowMs({ expiresAtMs: NOW - mins(5), intervalSec: 20, now: NOW })).toBe(20_000);
	});

	it('caps below one minute are floored, not treated as unset', () => {
		expect(waitWindowMs({ expiresAtMs: Number.NaN, intervalSec: 15, maxWaitMinutes: 0, now: NOW })).toBe(
			mins(1)
		);
	});
});
