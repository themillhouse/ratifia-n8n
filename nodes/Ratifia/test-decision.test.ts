import { describe, expect, it } from 'vitest';
import { buildTestDecision, TEST_TIMEOUT_SEC } from './test-decision';

const base = { runId: 'n8n-test-1', stepRef: 'Ratifia (test)', workflowRef: 'Refunds' };

type Ctx = {
	title: string;
	prompt: string;
	data: Record<string, { value?: unknown; src?: string } | unknown>;
	blocks: Array<{
		kind: string;
		fields?: Array<{ label: string; value: string }>;
		links?: Array<{ label: string; url: string; description?: string }>;
	}>;
};

describe('buildTestDecision', () => {
	it('names the approvers and expires on its own', () => {
		const body = buildTestDecision({ ...base, approvers: ['you@acme.com'] });
		expect(body.approvers).toEqual(['you@acme.com']);
		expect(body.timeoutSec).toBe(TEST_TIMEOUT_SEC);
		expect(body.policy).toBeUndefined();
	});

	// A policy owns who approves and when it expires; sending either alongside it
	// is refused by the API, so the two branches must stay mutually exclusive.
	it('defers to the policy, sending neither approvers nor an expiry', () => {
		const body = buildTestDecision({ ...base, policy: { key: 'refunds' } });
		expect(body.policy).toEqual({ key: 'refunds' });
		expect(body.approvers).toBeUndefined();
		expect(body.timeoutSec).toBeUndefined();
	});

	it('shows every provenance badge a real decision can show', () => {
		const ctx = buildTestDecision({ ...base, approvers: ['you@acme.com'] }).context as Ctx;
		const sources = Object.values(ctx.data).map((v) =>
			v && typeof v === 'object' && 'src' in v ? (v as { src?: string }).src : undefined,
		);
		expect(new Set(sources)).toEqual(new Set(['tool', 'ai', 'human', undefined]));
	});

	it('demonstrates the panels a reviewer would see', () => {
		const body = buildTestDecision({ ...base, approvers: ['you@acme.com'] });
		const ctx = body.context as Ctx;
		expect(ctx.blocks.map((b) => b.kind)).toEqual(['links', 'fields', 'text']);
		expect(body.proposedOutput).toMatchObject({ format: 'text' });
	});

	// FN-356 removed context.sourceUrl, and context is strict, so sending it is a
	// 400 rather than a dropped link.
	it('sends no sourceUrl', () => {
		expect(buildTestDecision({ ...base, approvers: ['you@acme.com'] }).context).not.toHaveProperty('sourceUrl');
	});

	// The API refuses a link that isn't http(s), and our own sample landing in that
	// refusal would be an embarrassing first impression.
	it('sends links the API will accept', () => {
		const ctx = buildTestDecision({ ...base, approvers: ['you@acme.com'] }).context as Ctx;
		const links = ctx.blocks.find((b) => b.kind === 'links')?.links ?? [];
		expect(links.length).toBeGreaterThan(1);
		for (const l of links) {
			expect(l.label.length).toBeGreaterThan(0);
			expect(l.url).toMatch(/^https:\/\//);
		}
	});

	it('says in the prompt that it is a test, since it lands in a real inbox', () => {
		const ctx = buildTestDecision({ ...base, approvers: ['you@acme.com'] }).context as Ctx;
		expect(ctx.title.toLowerCase()).toContain('test');
		expect(ctx.prompt.toLowerCase()).toContain('test');
	});

	// The API caps `data` at 100 entries and 32KB, and field values at 2000
	// characters. Our own sample has no business being the thing that trips them.
	it('stays inside the context limits', () => {
		const ctx = buildTestDecision({ ...base, approvers: ['you@acme.com'] }).context as Ctx;
		expect(Object.keys(ctx.data).length).toBeLessThanOrEqual(100);
		expect(JSON.stringify(ctx.data).length).toBeLessThan(32_000);
		for (const block of ctx.blocks) {
			for (const field of block.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(2000);
		}
	});

	it('carries the run identity through', () => {
		const body = buildTestDecision({ ...base, approvers: ['you@acme.com'] });
		expect(body).toMatchObject({
			engine: 'api',
			externalRunId: 'n8n-test-1',
			stepRef: 'Ratifia (test)',
			workflowRef: 'Refunds',
			required: true,
		});
	});
});
