import { describe, expect, it } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { hashFacts, readFactsTable } from '../nodes/Ratifia/Ratifia.node';

/** Minimal stub: readFactsTable only reads one parameter and names the node on error. */
const ctx = (rows: unknown[]) =>
	({
		getNodeParameter: () => ({ fact: rows }),
		getNode: () => ({ name: 'Ratifia' }),
	}) as unknown as IExecuteFunctions;

const read = (rows: unknown[]) => readFactsTable(ctx(rows), 0, 'factsTable');

describe('the Facts table', () => {
	it('hashes identically to the JSON escape hatch it replaces', () => {
		const { facts } = read([
			{ name: 'recipient', type: 'string', value: 'dana@acme.com' },
			{ name: 'amount', type: 'number', value: '620' },
			{ name: 'attachments', type: 'array', value: '["receipt-1042.pdf"]' },
		]);
		expect(hashFacts(facts)).toBe(
			hashFacts({ recipient: 'dana@acme.com', amount: 620, attachments: ['receipt-1042.pdf'] })
		);
	});

	it('types the value, so an array is not hashed as its JSON text', () => {
		const typed = read([{ name: 'a', type: 'array', value: '["x"]' }]).facts;
		const untyped = read([{ name: 'a', type: 'string', value: '["x"]' }]).facts;
		expect(hashFacts(typed)).not.toBe(hashFacts(untyped));
	});

	it('binds a value without transmitting it when Show Reviewer is off', () => {
		const { facts, data } = read([
			{ name: 'amount', type: 'number', value: '620', showReviewer: true, src: 'tool' },
			{ name: 'cardLast4', type: 'string', value: '4242', showReviewer: false },
		]);
		expect(facts).toEqual({ amount: 620, cardLast4: '4242' });
		expect(data).toEqual({ amount: { value: 620, src: 'tool' } });
		expect(JSON.stringify(data)).not.toContain('4242');
	});

	// The point of the table: the reviewer cannot be shown one value while the
	// approval binds another, because both come from the same row.
	it('shows the reviewer exactly what it binds', () => {
		const { facts, data } = read([
			{ name: 'amount', type: 'number', value: '1000', showReviewer: true, src: 'tool' },
		]);
		expect((data.amount as { value: number }).value).toBe(facts.amount);
	});

	it('carries the declared provenance and description', () => {
		const { data } = read([
			{ name: 'amount', type: 'number', value: '7200', showReviewer: true, src: 'ai', description: 'Model estimate' },
		]);
		expect(data.amount).toEqual({ value: 7200, src: 'ai', description: 'Model estimate' });
	});

	it('skips unnamed rows and refuses values that would not canonicalise', () => {
		expect(read([{ name: '  ', type: 'string', value: 'x' }]).facts).toEqual({});
		expect(() => read([{ name: 'a', type: 'number', value: 'not a number' }])).toThrow(/not a number/);
		expect(() => read([{ name: 'a', type: 'object', value: '{oops' }])).toThrow(/valid JSON/);
	});
});
