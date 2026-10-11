import { describe, expect, it } from 'vitest';
import { unwrap } from './Ratifia.node';

describe('unwrap', () => {
	it('unwraps a { decision: {...} } envelope', () => {
		expect(unwrap({ decision: { id: 'dec_1', status: 'PENDING' } })).toEqual({ id: 'dec_1', status: 'PENDING' });
	});

	it('keeps a flat decision whose `decision` field is the verdict', () => {
		const flat = { id: 'dec_1', status: 'APPROVED', decision: 'approve', policyVersion: 2 };
		expect(unwrap(flat)).toBe(flat);
	});

	it('keeps a flat pending decision (verdict null)', () => {
		const flat = { id: 'dec_1', status: 'PENDING', decision: null };
		expect(unwrap(flat)).toBe(flat);
	});

	it('treats a missing body as empty', () => {
		expect(unwrap(undefined)).toEqual({});
	});
});
