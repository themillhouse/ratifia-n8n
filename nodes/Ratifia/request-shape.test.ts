import { describe, expect, it } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { buildLinksBlock, buildProposedOutput, buildResponseSpec, dashboardUrl } from './Ratifia.node';

/**
 * A stand-in for the parts of IExecuteFunctions these builders touch: reading
 * parameters, and naming the node in an error.
 */
function ctx(params: Record<string, unknown>): IExecuteFunctions {
	return {
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getNode: () => ({ name: 'Ratifia' }),
	} as unknown as IExecuteFunctions;
}

describe('buildResponseSpec', () => {
	it('sends nothing for a plain approve/reject gate', () => {
		expect(buildResponseSpec(ctx({}), 0)).toBeUndefined();
		expect(buildResponseSpec(ctx({ answerType: 'approval' }), 0)).toBeUndefined();
	});

	it('asks for a typed answer', () => {
		expect(buildResponseSpec(ctx({ answerType: 'text' }), 0)).toEqual({ type: 'text' });
		expect(buildResponseSpec(ctx({ answerType: 'text', multiline: true }), 0)).toEqual({
			type: 'text',
			multiline: true,
		});
	});

	it('builds a choice from the fixed collection', () => {
		const spec = buildResponseSpec(
			ctx({
				answerType: 'select',
				'choices.choice': [
					{ id: 'duplicate', label: 'Duplicate charge', description: 'Charged twice' },
					{ id: 'goodwill', label: 'Goodwill' },
				],
			}),
			0,
		);
		expect(spec).toEqual({
			type: 'select',
			options: [
				{ id: 'duplicate', label: 'Duplicate charge', description: 'Charged twice' },
				{ id: 'goodwill', label: 'Goodwill' },
			],
		});
	});

	it('sets max only when multiple choices are allowed', () => {
		const choices = [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' },
		];
		expect(buildResponseSpec(ctx({ answerType: 'select', 'choices.choice': choices, allowMultiple: true }), 0)).toEqual(
			{ type: 'select', options: choices, max: 2 },
		);
	});

	// Refusing here rather than letting the API refuse it means the message
	// arrives while someone is editing the node, not mid-run.
	it('refuses fewer than two usable choices', () => {
		expect(() => buildResponseSpec(ctx({ answerType: 'select', 'choices.choice': [] }), 0)).toThrow(
			/at least two options/,
		);
		expect(() =>
			buildResponseSpec(
				ctx({ answerType: 'select', 'choices.choice': [{ id: 'a', label: 'A' }, { id: '', label: 'B' }] }),
				0,
			),
		).toThrow(/at least two options/);
	});

	it('refuses duplicate choice IDs', () => {
		expect(() =>
			buildResponseSpec(
				ctx({ answerType: 'select', 'choices.choice': [{ id: 'a', label: 'A' }, { id: 'a', label: 'Also A' }] }),
				0,
			),
		).toThrow(/unique/);
	});
});

describe('buildProposedOutput', () => {
	it('sends nothing without content, because presence is what makes a decision refinable', () => {
		expect(buildProposedOutput(ctx({}), 0)).toBeUndefined();
		expect(buildProposedOutput(ctx({ proposedOutput: { content: '   ', title: 'Reply' } }), 0)).toBeUndefined();
	});

	it('carries the draft and its labels', () => {
		expect(
			buildProposedOutput(
				ctx({ proposedOutput: { content: 'Hi Sam,\n\nRefunded.', title: 'Reply', format: 'markdown' } }),
				0,
			),
		).toEqual({ content: 'Hi Sam,\n\nRefunded.', title: 'Reply', format: 'markdown' });
	});
});

describe('buildLinksBlock', () => {
	it('sends nothing when the collection is empty', () => {
		expect(buildLinksBlock(ctx({}), 0)).toBeUndefined();
		expect(buildLinksBlock(ctx({ 'links.link': [] }), 0)).toBeUndefined();
	});

	it('builds the block from filled rows', () => {
		expect(
			buildLinksBlock(
				ctx({
					'links.link': [
						{ label: 'Support ticket', url: 'https://acme.test/SUP-1', description: 'Opened Tuesday' },
						{ label: 'Customer', url: 'https://crm.acme.test/001' },
					],
				}),
				0,
			),
		).toEqual({
			kind: 'links',
			title: 'Records',
			links: [
				{ label: 'Support ticket', url: 'https://acme.test/SUP-1', description: 'Opened Tuesday' },
				{ label: 'Customer', url: 'https://crm.acme.test/001' },
			],
		});
	});

	// A half-filled row is someone mid-edit, and the API refuses the whole request
	// over it. Dropping the row keeps the rest of the decision sendable.
	it('drops a row missing its label or URL, and the block when none is usable', () => {
		expect(
			buildLinksBlock(
				ctx({ 'links.link': [{ label: 'Ticket', url: '' }, { label: 'Customer', url: 'https://crm.acme.test/1' }] }),
				0,
			),
		).toMatchObject({ links: [{ label: 'Customer', url: 'https://crm.acme.test/1' }] });
		expect(buildLinksBlock(ctx({ 'links.link': [{ label: 'Ticket' }, { url: 'https://acme.test' }] }), 0)).toBeUndefined();
	});
});

describe('dashboardUrl', () => {
	it('maps the API host to the dashboard host, per environment', () => {
		expect(dashboardUrl('https://api.ratifia.com')).toBe('https://app.ratifia.com');
		expect(dashboardUrl('https://api.eu.example.com')).toBe('https://app.eu.example.com');
	});

	it('ignores a trailing path on the credential URL', () => {
		expect(dashboardUrl('https://api.ratifia.com/')).toBe('https://app.ratifia.com');
	});

	// Guessing would put a link to nowhere in the output.
	it('gives up on hosts it cannot map', () => {
		expect(dashboardUrl('http://localhost:3001')).toBeUndefined();
		expect(dashboardUrl('https://ratifia.example.com')).toBeUndefined();
		expect(dashboardUrl('not a url')).toBeUndefined();
	});
});
