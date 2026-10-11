import type { IDataObject } from 'n8n-workflow';

/**
 * The payload behind the "Send a Test Decision" operation.
 *
 * n8n has no way for a community node to put a working button in the parameter
 * panel (the `button` property type binds only to n8n's own AI code generation),
 * so the test is an operation and "Execute step" is the button.
 *
 * The sample is deliberately full rather than minimal: every panel a real
 * decision can show is present, so what comes back tells the builder what their
 * reviewers will actually be looking at. One fact per provenance source, so all
 * four badges render. Linked records, because that is what we tell people to send
 * instead of copying a record in. A draft, so the refine panel appears.
 *
 * It expires on its own, because a test nobody answers should not sit in
 * somebody's inbox for a week.
 */
export const TEST_TIMEOUT_SEC = 900;

export function buildTestDecision(opts: {
	runId: string;
	stepRef: string;
	workflowRef: string;
	approvers?: string[];
	policy?: { key: string; version?: number };
}): IDataObject {
	const { runId, stepRef, workflowRef, approvers, policy } = opts;

	return {
		engine: 'api',
		externalRunId: runId,
		stepRef,
		workflowRef,
		required: true,
		context: {
			title: 'Test decision from n8n: refund $1,250.00 to ACME Corp',
			prompt:
				'This is a test decision sent from n8n. Nothing happens either way, so approve or reject it to see what your workflow receives back.\n\nThe question a real one would ask: the customer reports a double charge on invoice INV-2201. Refund it?',
			aiReasoning:
				'Two charges of the same amount to the same card within four minutes. The second has no matching order.',
			data: {
				invoice: { value: 'INV-2201', src: 'tool', description: 'Invoice the charge belongs to' },
				amountCents: {
					value: 125000,
					src: 'tool',
					description: 'Duplicate charge amount, read from the payment processor',
					meta: { api: 'stripe.charges.retrieve', chargeId: 'ch_3PqTest' },
				},
				reason: {
					value: 'duplicate',
					src: 'ai',
					description: 'Classified from the support ticket',
					meta: { confidence: 0.91 },
				},
				agentNote: { value: 'Customer called twice about this', src: 'human' },
				accountTier: 'enterprise',
			},
			blocks: [
				{
					kind: 'links',
					title: 'Records',
					links: [
						{
							label: 'Support ticket',
							url: 'https://docs.ratifia.com/pii',
							description: 'Where a real decision would link the ticket',
						},
						{ label: 'Customer record', url: 'https://docs.ratifia.com/n8n' },
						{ label: 'Invoice INV-2201', url: 'https://docs.ratifia.com/hitl' },
					],
				},
				{
					kind: 'fields',
					title: 'Details',
					fields: [{ label: 'Charged twice on', value: '2026-09-24' }],
				},
				{
					kind: 'text',
					title: 'What the workflow would do next',
					text: 'On approve: issue the refund and email the customer. On reject: leave the charge and reply asking for more detail.',
				},
			],
		},
		proposedOutput: {
			title: 'Reply to the customer',
			format: 'text',
			content:
				"Hi,\n\nYou're right, you were charged twice for invoice INV-2201. I've refunded the duplicate charge of $1,250.00; it should be back on your card within a few business days.\n\nSorry for the trouble.",
		},
		// Ad hoc approvers, or the policy decides. Never both: the API refuses that
		// combination rather than quietly picking one.
		...(policy ? { policy } : { approvers, timeoutSec: TEST_TIMEOUT_SEC }),
	};
}
