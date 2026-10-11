import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { canonicalFacts, hashFacts } from '../nodes/Ratifia/Ratifia.node';

// The node carries its own copy of the facts hash, because a verified community
// node may not have runtime dependencies. It must match every other Ratifia
// client byte for byte, or an approval requested here could never be consumed
// by the customer's own code (and the reverse). The golden vectors are that
// contract: an identical copy lives with every client. Change them only
// together with the algorithm, in every client at once.
interface Vector {
	name: string;
	facts: Record<string, unknown>;
	canonical: string;
	sha256: string;
}
const { vectors } = JSON.parse(
	readFileSync(resolve(__dirname, 'facts-hash.vectors.json'), 'utf8'),
) as { vectors: Vector[] };

describe('facts hash golden vectors', () => {
	it('has vectors to check', () => {
		expect(vectors.length).toBeGreaterThan(10);
	});

	it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
		expect(canonicalFacts(v.facts)).toBe(v.canonical);
		expect(hashFacts(v.facts as never)).toBe(v.sha256);
	});

	it('the file is self-consistent: each sha256 is the digest of its canonical string', () => {
		for (const v of vectors) {
			expect(createHash('sha256').update(v.canonical, 'utf8').digest('hex')).toBe(v.sha256);
		}
	});
});

describe('facts hashing', () => {
	it('refuses values JSON would silently change', () => {
		expect(() => canonicalFacts({ a: undefined })).toThrow(/undefined/);
		expect(() => canonicalFacts({ a: Number.NaN })).toThrow(/finite/);
		expect(() => canonicalFacts({ a: Number.POSITIVE_INFINITY })).toThrow(/finite/);
		expect(() => canonicalFacts({ a: new Date(0) })).toThrow(/plain JSON/);
		expect(() => canonicalFacts({ a: new Map() })).toThrow(/plain JSON/);
	});
});
