import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	IDataObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { createHash } from 'crypto';
import { buildTestDecision, TEST_TIMEOUT_SEC } from './test-decision';

/** Terminal states. Anything else means the decision is still open. */
const TERMINAL = ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'];

interface DecisionView {
	id?: string;
	status?: string;
	decidedBy?: string | null;
	note?: string | null;
	[k: string]: unknown;
}

export class Ratifia implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ratifia',
		name: 'ratifia',
		icon: 'file:ratifia.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Pause for human approval and continue on the answer',
		defaults: { name: 'Ratifia' },
		// String literals rather than the NodeConnectionType enum: it is exported
		// as a type-only symbol in some n8n-workflow versions, and this form is
		// accepted by all of them.
		inputs: ['main'] as unknown as INodeTypeDescription['inputs'],
		outputs: ['main'] as unknown as INodeTypeDescription['outputs'],
		credentials: [{ name: 'ratifiaApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'requestAndWait',
				options: [
					{
						name: 'Request Approval and Wait',
						value: 'requestAndWait',
						description: 'Ask a human and hold the workflow until they answer',
						action: 'Request approval and wait for the verdict',
					},
					{
						name: 'Request Approval',
						value: 'request',
						description: 'Ask a human and continue immediately, returning the decision ID',
						action: 'Request approval without waiting',
					},
					{
						name: 'Verify Approval',
						value: 'verify',
						description:
							'Check, without spending it, that an approval covers the action you are about to take',
						action: 'Verify an approval',
					},
					{
						name: 'Consume Approval',
						value: 'consume',
						description:
							'Spend an approval on exactly one action, immediately before you take it. Refuses anything it does not cover.',
						action: 'Consume an approval',
					},
					{
						name: 'Get Decision',
						value: 'get',
						description: 'Read the current state of a decision',
						action: 'Get a decision',
					},
					{
						name: 'Cancel Decision',
						value: 'cancel',
						description: 'Withdraw a decision nobody needs to answer any more',
						action: 'Cancel a decision',
					},
					{
						name: 'Send a Test Decision',
						value: 'test',
						description:
							'Send yourself a sample decision to see how it looks in Ratifia. Creates a real decision that expires on its own; nothing else happens either way.',
						action: 'Send a test decision',
					},
				],
			},

			// ── request / requestAndWait ──────────────────────────────────────
			{
				displayName: 'What Are You Asking?',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				placeholder: 'Send this refund of $840 to the customer?',
				description:
					'The question the reviewer sees. Write it so someone with no context can answer it.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'] } },
			},
			{
				displayName: 'Policy Name or ID',
				name: 'policy',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getPolicies' },
				default: '',
				description:
					'Policy supplying who approves, how many must agree, the expiry, and which Data fields are required. Choose from the list of policies in your org, or specify an ID using an expression. Without one, set Approvers to name who can answer.',
				displayOptions: { show: { operation: ['request', 'requestAndWait', 'test'] } },
			},

			// ── test ──────────────────────────────────────────────────────────
			{
				displayName: 'Send To',
				name: 'testApprovers',
				type: 'string',
				default: '',
				placeholder: 'you@acme.com',
				description:
					'Who receives the test, comma-separated. They must already be a verified approver in your org. Leave empty to let the policy above decide.',
				displayOptions: { show: { operation: ['test'] } },
			},
			{
				displayName:
					'Creates a real decision in your org with sample facts, a source link and an editable draft, so you can see every panel a reviewer would. It expires by itself after 15 minutes and nothing acts on the verdict. Run it with Execute Step.',
				name: 'testNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { operation: ['test'] } },
			},
			// ── the records the decision is about (FN-356) ─────────────────────
			{
				displayName: 'Records',
				name: 'links',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description:
					'Links to what this decision is about: the ticket, the CRM record, the invoice. The reviewer sees them as links. If a record holds personal data, link to it rather than copying the values into Data, so your own access controls still decide who may read it.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'] } },
				options: [
					{
						displayName: 'Record',
						name: 'link',
						values: [
							{
								displayName: 'Label',
								name: 'label',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'Support ticket',
							},
							{
								displayName: 'URL',
								name: 'url',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'https://acme.atlassian.net/browse/SUP-4471',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								description: 'Optional line under the link',
							},
						],
					},
				],
			},

			// ── what you're asking for back (FN-180) ──────────────────────────
			{
				displayName: 'Answer Type',
				name: 'answerType',
				type: 'options',
				default: 'approval',
				description:
					'What the reviewer is asked for. Approve/reject is the default; a choice or a typed answer comes back on the output as responseValue.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'] } },
				options: [
					{ name: 'Approve or Reject', value: 'approval', description: 'A yes/no gate' },
					{ name: 'Choice', value: 'select', description: 'Pick from options you define, e.g. a refund reason' },
					{ name: 'Typed Answer', value: 'text', description: 'Ask for a value or an explanation in their own words' },
				],
			},
			{
				displayName: 'Choices',
				name: 'choices',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description: 'At least two. The chosen ID comes back on responseValue, so keep IDs stable.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'], answerType: ['select'] } },
				options: [
					{
						displayName: 'Choice',
						name: 'choice',
						values: [
							{
								displayName: 'ID',
								name: 'id',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'duplicate_charge',
								description: 'What your workflow branches on. Not shown to the reviewer.',
							},
							{
								displayName: 'Label',
								name: 'label',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'Duplicate charge',
								description: 'What the reviewer sees',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								description: 'Optional line under the label',
							},
						],
					},
				],
			},
			{
				displayName: 'Allow Multiple Choices',
				name: 'allowMultiple',
				type: 'boolean',
				default: false,
				description: 'Whether the reviewer can pick more than one. Off means exactly one.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'], answerType: ['select'] } },
			},
			{
				displayName: 'Multiline Answer',
				name: 'multiline',
				type: 'boolean',
				default: false,
				description: 'Whether to give the reviewer a text area rather than a single line',
				displayOptions: { show: { operation: ['request', 'requestAndWait'], answerType: ['text'] } },
			},

			// ── refinement: a draft the reviewer can rewrite (FN-185) ──────────
			{
				displayName: 'Draft for Review',
				name: 'proposedOutput',
				type: 'collection',
				placeholder: 'Add draft',
				default: {},
				description:
					'An editable draft, e.g. the email you intend to send. The reviewer can rewrite it before approving, and the approved text comes back on the output as output (refinedOutput when they changed it, proposedOutput when they did not). Send the approved text, not your original.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'] } },
				options: [
					{
						displayName: 'Content',
						name: 'content',
						type: 'string',
						typeOptions: { rows: 6 },
						default: '',
						description: 'The draft itself. Nothing is sent as a draft while this is empty.',
					},
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
						description: 'Heading above the draft, e.g. "Reply to the customer"',
					},
					{
						displayName: 'Format',
						name: 'format',
						type: 'options',
						default: 'text',
						options: [
							{ name: 'Plain Text', value: 'text' },
							{ name: 'Markdown', value: 'markdown' },
						],
					},
				],
			},

			// FN-358: one table for the facts. A row is always bound into the hash;
			// "Show Reviewer" additionally sends it, in the clear, as context.data.
			// One source, two uses, so what the reviewer saw and what the approval
			// binds cannot drift apart. Options > Facts (JSON) / Data (JSON) remain
			// as an escape hatch for genuinely nested structures.
			{
				displayName: 'Facts',
				name: 'factsTable',
				placeholder: 'Add fact',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description:
					'The values this approval covers. Every row is hashed; only the hash is sent. Tick Show Reviewer to also send the value so the reviewer can see it.',
				displayOptions: { show: { operation: ['request', 'requestAndWait'] } },
				options: [
					{
						displayName: 'Fact',
						name: 'fact',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								required: true,
								description: 'Field name, e.g. amount',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'string',
								description:
									'How the value is canonicalised before hashing. Getting this wrong changes the hash, so an array sent as a string will not match at the action.',
								options: [
									{ name: 'String', value: 'string' },
									{ name: 'Number', value: 'number' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Array (JSON)', value: 'array' },
									{ name: 'Object (JSON)', value: 'object' },
								],
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
							{
								displayName: 'Show Reviewer',
								name: 'showReviewer',
								type: 'boolean',
								default: true,
								description:
									'Whether to send the value in the clear so the reviewer can see it. Off means only the hash leaves n8n, so sensitive values are bound but never transmitted.',
							},
							{
								displayName: 'Source',
								name: 'src',
								type: 'options',
								default: 'tool',
								description:
									'Where this value came from. Shown to the reviewer as a badge. Set it honestly: a value a model produced is ai, not tool.',
								displayOptions: { show: { showReviewer: [true] } },
								options: [
									{ name: 'Looked Up (Tool)', value: 'tool' },
									{ name: 'AI-Derived', value: 'ai' },
									{ name: 'Entered by a Person', value: 'human' },
									{ name: 'Not Stated', value: 'unknown' },
								],
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								description: 'Optional note shown to the reviewer, e.g. "From Stripe"',
								displayOptions: { show: { showReviewer: [true] } },
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { operation: ['request', 'requestAndWait'] } },
				options: [
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
						description: 'Short headline the reviewer UI leads with, instead of the full question',
					},
					{
						displayName: 'Data (JSON)',
						name: 'data',
						type: 'json',
						default: '{}',
						description:
							'The facts of the decision, shown to the reviewer, e.g. {"amount": 7200}. Say where a value came from with {"amount": {"value": 7200, "src": "tool", "description": "From Stripe"}}; src is ai, tool, human or unknown. A policy with a context contract refuses data that does not match it.',
					},
					{
						displayName: 'Facts (JSON)',
						name: 'facts',
						type: 'json',
						default: '{}',
						description:
							'The exact values this approval covers, for example the recipient, subject and body of an email. Only a hash is sent. Pass the same facts to Verify or Consume before acting: if anything changed, the approval no longer covers it.',
					},
					{
						displayName: 'Approvers',
						name: 'approvers',
						type: 'string',
						placeholder: 'dana@acme.com, lee@acme.com',
						default: '',
						description: 'Without a policy: who can answer, comma-separated. Not allowed with a policy (the policy decides who). Prefer a policy for anything recurring.',
					},
					{
						displayName: 'Approvals Required',
						name: 'approvalsRequired',
						type: 'number',
						default: 1,
						description: 'Without a policy: how many of the approvers must approve. At most the number of approvers. Not allowed with a policy.',
					},
					{
						displayName: 'Expected Policy Version',
						name: 'policyVersion',
						type: 'number',
						default: 0,
						description: 'With a policy: the version this workflow was built against. If the policy has changed since, the request fails instead of running under rules you have not reviewed. 0 accepts the current version.',
					},
					{
						displayName: 'Required',
						name: 'required',
						type: 'boolean',
						default: true,
						description:
							'Whether a human must decide. Your workflow makes this call: put an IF in front, or map an expression that is true for the cases that need review. Off means no decision is created and the workflow continues.',
					},
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeoutSec',
						type: 'number',
						default: 0,
						description:
							'Without a policy: auto-expire the decision after this long. 0 leaves it open indefinitely. An expired decision resolves as EXPIRED, not approved. Not allowed with a policy (the policy sets the expiry).',
					},
					{
						displayName: 'Workflow Reference',
						name: 'workflowRef',
						type: 'string',
						default: '',
						description:
							'Groups related decisions in the dashboard. Defaults to this n8n workflow name, which is usually what you want.',
					},
				],
			},

			// ── waiting behaviour ─────────────────────────────────────────────
			{
				displayName: 'Wait Options',
				name: 'waitOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { operation: ['requestAndWait'] } },
				options: [
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollIntervalSec',
						type: 'number',
						default: 15,
						description: 'How often to check for a verdict. Below 5s is rejected.',
					},
					{
						displayName: 'Give Up After (Minutes)',
						name: 'maxWaitMinutes',
						type: 'number',
						default: 60,
						description:
							'Cap on how long to wait. Leave it unset and the node waits until the decision expires, which the policy decides. It expires nothing itself: set shorter than the expiry and this node stops watching while the decision is still open, so a verdict can arrive with nothing listening. Each waiting execution stays active the whole time.',
					},
					{
						displayName: 'Fail on Reject',
						name: 'failOnReject',
						type: 'boolean',
						default: false,
						description:
							'Whether to error when a human rejects. Off by default so you can branch on status with an IF node, which is usually clearer than error handling.',
					},
				],
			},

			// ── get / cancel ──────────────────────────────────────────────────
			{
				displayName: 'Decision ID',
				name: 'decisionId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'dec_a1b2c3...',
				displayOptions: { show: { operation: ['get', 'cancel', 'verify', 'consume'] } },
			},
			// FN-358: the same table on the action side. No Show Reviewer or Source
			// here: nothing is sent, the rows exist only to rebuild the hash. Build
			// them from what you are ABOUT TO DO, and where correctness depends on
			// external state, read that state again here rather than trusting what
			// you were handed.
			{
				displayName: 'Facts',
				name: 'actionFactsTable',
				placeholder: 'Add fact',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description:
					'Rebuild the approved facts from the action you are about to take. They must equal the facts the approval was requested with, or this returns facts_mismatch.',
				displayOptions: { show: { operation: ['verify', 'consume'] } },
				options: [
					{
						displayName: 'Fact',
						name: 'fact',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'string',
								description: 'Must match the type used when the approval was requested',
								options: [
									{ name: 'String', value: 'string' },
									{ name: 'Number', value: 'number' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Array (JSON)', value: 'array' },
									{ name: 'Object (JSON)', value: 'object' },
								],
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Facts (JSON)',
				name: 'actionFacts',
				type: 'json',
				default: '{}',
				description:
					'Escape hatch for nested facts. Merged with the Facts table above; the table wins on a name collision.',
				displayOptions: { show: { operation: ['verify', 'consume'] } },
			},
			{
				displayName: 'Step',
				name: 'stepRef',
				type: 'string',
				default: '',
				placeholder: 'Send Refund Approval',
				description:
					'The step the approval was raised for, which is the requesting node\'s name unless you overrode it. Naming it here refuses an approval raised for a different step (step_mismatch). Leave empty to skip that check.',
				displayOptions: { show: { operation: ['verify', 'consume'] } },
			},
			{
				displayName: 'Consumer',
				name: 'consumer',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'send-email:{{ $json.messageId }}',
				description:
					'A stable key for this one action. A retry with the same key is reported as already consumed, so it is safe to retry; a different key is refused.',
				displayOptions: { show: { operation: ['consume'] } },
			},
			{
				displayName: 'Reason',
				name: 'cancelNote',
				type: 'string',
				default: '',
				description: 'Recorded on the decision, so the audit trail says why it was withdrawn',
				displayOptions: { show: { operation: ['cancel'] } },
			},
		],
	};

	methods = {
		loadOptions: {
			/**
			 * Populate the policy picker from the org the credential belongs to.
			 *
			 * An empty first entry is deliberate: a policy is optional, and without
			 * it there is no way back to "no policy" once one is chosen.
			 */
			async getPolicies(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const creds = await this.getCredentials('ratifiaApi');
				const baseUrl = String(creds.baseUrl || 'https://api.ratifia.com').replace(/\/+$/, '');

				const res = (await this.helpers.httpRequestWithAuthentication.call(this, 'ratifiaApi', {
					method: 'GET',
					url: `${baseUrl}/v1/worker/policies`,
					json: true,
				})) as { policies?: Array<{ key: string; name?: string; description?: string }> };

				const options: INodePropertyOptions[] = [
					{ name: '- None -', value: '', description: 'Use your org defaults instead of a policy' },
				];

				for (const p of res.policies ?? []) {
					options.push({
						// Show the label, but the key is what code references and
						// what survives a rename, so it is the value.
						name: p.name && p.name !== p.key ? `${p.name} (${p.key})` : p.key,
						value: p.key,
						description: p.description || undefined,
					});
				}
				return options;
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		const creds = await this.getCredentials('ratifiaApi');
		const baseUrl = String(creds.baseUrl || 'https://api.ratifia.com').replace(/\/+$/, '');
		// So a run leaves behind something to click, not just an id.
		const appUrl = dashboardUrl(baseUrl);

		const call = async (opts: IHttpRequestOptions) =>
			this.helpers.httpRequestWithAuthentication.call(this, 'ratifiaApi', {
				// FN-288: our published create SLA is 60s. Without an explicit
				// timeout a slow response hangs the execution rather than failing.
				timeout: 60_000,
				json: true,
				...opts,
			});

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;

			try {
				if (operation === 'verify' || operation === 'consume') {
					const id = this.getNodeParameter('decisionId', i) as string;
					// Table rows win over the JSON escape hatch on a name collision.
					const actionTable = readFactsTable(this, i, 'actionFactsTable');
					const actionJson = parseFacts(this.getNodeParameter('actionFacts', i, {}), this, i) ?? {};
					const factsHash = hashFacts({ ...actionJson, ...actionTable.facts });
					// Naming the step is what makes `step_mismatch` possible: without it
					// an approval raised for some other step in the same org would pass.
					const stepRef = (this.getNodeParameter('stepRef', i, '') as string) || undefined;
					const result =
						operation === 'verify'
							? await call({
									method: 'GET',
									url: `${baseUrl}/v1/worker/decisions/${encodeURIComponent(id)}/verify`,
									qs: { factsHash, ...(stepRef ? { stepRef } : {}) },
								})
							: await call({
									method: 'POST',
									url: `${baseUrl}/v1/worker/decisions/${encodeURIComponent(id)}/consume`,
									body: {
										factsHash,
										consumer: this.getNodeParameter('consumer', i) as string,
										...(stepRef ? { stepRef } : {}),
									},
								});
					// Returned as-is: `valid` / `consumed` / `alreadyConsumed` / `reason`
					// are what the next node branches on.
					out.push({ json: { ...(result as IDataObject), factsHash }, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'get' || operation === 'cancel') {
					const id = this.getNodeParameter('decisionId', i) as string;
					const decision =
						operation === 'get'
							? await call({ method: 'GET', url: `${baseUrl}/v1/worker/decisions/${id}` })
							: await call({
									method: 'POST',
									url: `${baseUrl}/v1/worker/decisions/${id}/cancel`,
									body: { note: (this.getNodeParameter('cancelNote', i) as string) || undefined },
								});
					out.push({ json: withUrl(unwrap(decision), id, appUrl), pairedItem: { item: i } });
					continue;
				}

				if (operation === 'test') {
					const policyKey = (this.getNodeParameter('policy', i, '') as string) || undefined;
					const approvers = splitEmails(this.getNodeParameter('testApprovers', i, '') as string);
					// The API would refuse this with 422 approver_required after the
					// round trip. Say it here, where it reads as instructions.
					if (!policyKey && approvers.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Nobody to send the test to. Put your own email in Send To, or pick a Policy that names approvers.',
							{ itemIndex: i },
						);
					}
					const body = buildTestDecision({
						runId: `n8n-test-${this.getExecutionId()}`,
						stepRef: `${this.getNode().name} (test)`,
						workflowRef: this.getWorkflow().name || 'n8n',
						...(policyKey ? { policy: { key: policyKey } } : { approvers }),
					});
					const created = unwrap(await call({ method: 'POST', url: `${baseUrl}/v1/worker/decisions`, body }));
					const testId = (created.decisionId ?? created.id) as string | undefined;
					out.push({
						json: withUrl(
							{
								...created,
								sentTo: policyKey ? `policy:${policyKey}` : approvers.join(', '),
								expiresInMinutes: Math.round(TEST_TIMEOUT_SEC / 60),
							},
							testId,
							appUrl,
						),
						pairedItem: { item: i },
					});
					continue;
				}

				// ── create ────────────────────────────────────────────────────
				const prompt = this.getNodeParameter('prompt', i) as string;
				const policy = (this.getNodeParameter('policy', i) as string) || undefined;
				const options = this.getNodeParameter('options', i, {}) as IDataObject;

				let data: IDataObject | undefined;
				const rawData = options.data;
				if (rawData !== undefined && rawData !== '' && rawData !== '{}') {
					try {
						data =
							typeof rawData === 'string'
								? (JSON.parse(rawData) as IDataObject)
								: (rawData as IDataObject);
					} catch {
						throw new NodeOperationError(
							this.getNode(),
							'Data is not valid JSON. It is shown to the reviewer, so it must parse.',
							{ itemIndex: i },
						);
					}
				}

				// PD-003: ad hoc names its approvers; a policy owns who, how many
				// and the expiry.
				const approvers = splitEmails(options.approvers);
				const approvalsRequired = Number(options.approvalsRequired ?? 1);
				const policyVersion = Number(options.policyVersion ?? 0);
				const timeoutSec = Number(options.timeoutSec ?? 0);
				// FN-358: the Facts table is the primary source. Rows marked Show
				// Reviewer also land in `data`, so the reviewer cannot be shown one
				// value while the approval binds another. The JSON fields remain for
				// nested structures and lose to the table on a name collision.
				const factsTable = readFactsTable(this, i, 'factsTable');
				const jsonFacts = parseFacts(options.facts, this, i);
				const facts =
					Object.keys(factsTable.facts).length > 0 || jsonFacts
						? { ...(jsonFacts ?? {}), ...factsTable.facts }
						: undefined;
				if (Object.keys(factsTable.data).length > 0) {
					data = { ...(data ?? {}), ...factsTable.data };
				}
				const responseSpec = buildResponseSpec(this, i);
				const proposedOutput = buildProposedOutput(this, i);
				const linksBlock = buildLinksBlock(this, i);

				const body: IDataObject = {
					// `api` is the engine for callers with no parked step to resume.
					// n8n polls for its own verdict, exactly as the MCP server does.
					engine: 'api',
					externalRunId: `n8n-${this.getExecutionId()}`,
					stepRef: this.getNode().name,
					workflowRef: (options.workflowRef as string) || this.getWorkflow().name || 'n8n',
					required: options.required === undefined ? true : Boolean(options.required),
					context: {
						prompt,
						...(options.title ? { title: options.title as string } : {}),
						...(data ? { data } : {}),
						...(linksBlock ? { blocks: [linksBlock] } : {}),
					},
					...(responseSpec ? { responseSpec } : {}),
					...(proposedOutput ? { proposedOutput } : {}),
					...(policy ? { policy: { key: policy, ...(policyVersion > 0 ? { version: policyVersion } : {}) } } : {}),
					// Sent as set, even with a policy, so a conflict is refused loudly
					// (field_owned_by_policy) rather than silently dropped.
					...(approvers.length > 0 ? { approvers } : {}),
					...(approvalsRequired > 1 ? { approvalsRequired } : {}),
					...(timeoutSec > 0 ? { timeoutSec } : {}),
					...(facts && Object.keys(facts).length > 0 ? { factsHash: hashFacts(facts) } : {}),
				};

				const created = unwrap(await call({ method: 'POST', url: `${baseUrl}/v1/worker/decisions`, body }));
				const decisionId = (created.decisionId ?? created.id) as string | undefined;

				// No approval was needed: `required` was false, or the org's policy gate
				// resolved not-required. Ratifia answers 200 with no decision id, and the
				// workflow is meant to carry on. Waiting is not an error here, there is
				// simply nothing to wait for.
				if (created.approvalNeeded === false) {
					out.push({
						json: { ...created, approved: true, rejected: false, expired: false },
						pairedItem: { item: i },
					});
					continue;
				}

				if (operation === 'request') {
					out.push({ json: withUrl(created, decisionId, appUrl), pairedItem: { item: i } });
					continue;
				}

				if (!decisionId) {
					throw new NodeOperationError(
						this.getNode(),
						'Ratifia said an approval is needed but returned no decision ID, so there is nothing to wait on.',
						{ itemIndex: i },
					);
				}

				// ── wait ──────────────────────────────────────────────────────
				const wait = this.getNodeParameter('waitOptions', i, {}) as IDataObject;
				const intervalSec = Math.max(5, Number(wait.pollIntervalSec ?? 15));
				const failOnReject = Boolean(wait.failOnReject);

				const expiresAtMs = typeof created.expiresAt === 'string' ? Date.parse(created.expiresAt) : NaN;
				const maxWaitMs = waitWindowMs({
					expiresAtMs,
					intervalSec,
					maxWaitMinutes: wait.maxWaitMinutes === undefined ? undefined : Number(wait.maxWaitMinutes),
				});
				const deadline = Date.now() + maxWaitMs;

				let decision: DecisionView = { id: decisionId, status: 'PENDING' };
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, intervalSec * 1000));
					decision = unwrap(
						await call({ method: 'GET', url: `${baseUrl}/v1/worker/decisions/${decisionId}` }),
					) as DecisionView;
					if (decision.status && TERMINAL.includes(decision.status)) break;
				}

				if (!decision.status || !TERMINAL.includes(decision.status)) {
					throw new NodeOperationError(
						this.getNode(),
						`Gave up waiting after ${Math.round(maxWaitMs / 60000)} minutes, but the decision is still open in Ratifia (${decisionId})` +
							(Number.isFinite(expiresAtMs) ? ` until ${created.expiresAt}` : ', and it never expires') +
							'. Only this node stopped watching, so a verdict can still arrive with nothing listening. Raise Give Up After, or shorten the expiry on the policy. Use Get Decision to pick it up later.',
						{ itemIndex: i },
					);
				}

				if (failOnReject && decision.status !== 'APPROVED') {
					throw new NodeOperationError(
						this.getNode(),
						`Not approved: ${decision.status}${decision.note ? ` - ${decision.note}` : ''}`,
						{ itemIndex: i },
					);
				}

				out.push({
					json: {
						...(decision as IDataObject),
						// Convenience flags, so a downstream IF can test one field
						// rather than string-matching a status.
						approved: decision.status === 'APPROVED',
						rejected: decision.status === 'REJECTED',
						expired: decision.status === 'EXPIRED',
						...(appUrl ? { url: `${appUrl}/decisions/${decisionId}` } : {}),
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [out];
	}
}

/**
 * FN-180: the answer shape. Omitted for a plain approve/reject gate, which is
 * what the API assumes when there is no `responseSpec`.
 */
export function buildResponseSpec(ctx: IExecuteFunctions, i: number): IDataObject | undefined {
	const answerType = ctx.getNodeParameter('answerType', i, 'approval') as string;

	if (answerType === 'text') {
		const multiline = ctx.getNodeParameter('multiline', i, false) as boolean;
		return { type: 'text', ...(multiline ? { multiline: true } : {}) };
	}

	if (answerType !== 'select') return undefined;

	const raw = ctx.getNodeParameter('choices.choice', i, []) as Array<{
		id?: string;
		label?: string;
		description?: string;
	}>;
	const options = raw
		.map((c) => ({
			id: String(c.id ?? '').trim(),
			label: String(c.label ?? '').trim(),
			...(c.description ? { description: String(c.description).trim() } : {}),
		}))
		.filter((c) => c.id && c.label);

	// The API refuses fewer than two, and it would refuse them at the far end of
	// a workflow run. Fail here, where the message can say what to do about it.
	if (options.length < 2) {
		throw new NodeOperationError(
			ctx.getNode(),
			'A choice needs at least two options, each with an ID and a label.',
			{ itemIndex: i },
		);
	}
	const ids = new Set(options.map((c) => c.id));
	if (ids.size !== options.length) {
		throw new NodeOperationError(ctx.getNode(), 'Choice IDs must be unique; your workflow branches on them.', {
			itemIndex: i,
		});
	}

	const allowMultiple = ctx.getNodeParameter('allowMultiple', i, false) as boolean;
	return { type: 'select', options, ...(allowMultiple ? { max: options.length } : {}) };
}

/**
 * FN-185: the editable draft. Only sent when there is content, because its mere
 * presence is what makes a decision refinable.
 */
/**
 * FN-356: the `links` context block. Omitted when no row has both a label and a
 * URL, so an empty collection doesn't send an empty block the API would refuse.
 */
export function buildLinksBlock(ctx: IExecuteFunctions, i: number): IDataObject | undefined {
	const rows = ctx.getNodeParameter('links.link', i, []) as Array<{
		label?: string;
		url?: string;
		description?: string;
	}>;
	const links = rows
		.map((l) => ({
			label: String(l.label ?? '').trim(),
			url: String(l.url ?? '').trim(),
			...(l.description ? { description: String(l.description).trim() } : {}),
		}))
		.filter((l) => l.label && l.url);
	if (links.length === 0) return undefined;
	return { kind: 'links', title: 'Records', links };
}

export function buildProposedOutput(ctx: IExecuteFunctions, i: number): IDataObject | undefined {
	const draft = ctx.getNodeParameter('proposedOutput', i, {}) as IDataObject;
	const content = String(draft.content ?? '');
	if (!content.trim()) return undefined;
	return {
		content,
		...(draft.title ? { title: String(draft.title) } : {}),
		...(draft.format ? { format: String(draft.format) } : {}),
	};
}

/**
 * The dashboard origin for the API the credential points at: `api.ratifia.com`
 * becomes `app.ratifia.com`, and any other `api.` host maps the same way. Undefined for anything
 * that isn't an `api.` host (a tunnel, localhost, a self-hosted name), because a
 * link to the wrong place is worse than no link.
 */
export function dashboardUrl(apiBaseUrl: string): string | undefined {
	try {
		const url = new URL(apiBaseUrl);
		if (!url.hostname.startsWith('api.')) return undefined;
		url.hostname = `app.${url.hostname.slice('api.'.length)}`;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** Add the reviewer-facing link to an output item, when we can build one. */
function withUrl(json: IDataObject, decisionId: string | undefined, appUrl?: string): IDataObject {
	if (!decisionId || !appUrl) return json;
	return { ...json, url: `${appUrl}/decisions/${decisionId}` };
}

/**
 * The API returns some reads wrapped as `{ decision: {...} }` and some flat. A
 * flat decision also has a `decision` field, but it is the verdict string
 * (`approve` / `reject` / null), so only unwrap when it is an object.
 */
export function unwrap(res: unknown): IDataObject {
	const obj = (res ?? {}) as IDataObject;
	const inner = obj.decision;
	return inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? (inner as IDataObject) : obj;
}

/** A comma-separated address list, however tidily it was typed. */
export function splitEmails(raw: unknown): string[] {
	return String(raw ?? '')
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean);
}

/**
 * FN-364: how long Request Approval and Wait should keep polling.
 *
 * Wait for as long as the decision is actually open. `expiresAt` comes from the
 * policy, or the ad hoc timeoutSec, and the API returns it so an adapter can
 * size its wait to it; the Inngest adapter already does. A flat hour against a
 * longer policy expiry strands the approval: this node gives up, the decision
 * stays PENDING, and a real verdict arrives later with nothing listening. A
 * person did their job and the action never happened.
 *
 * `maxWaitMinutes` stays an explicit cap for an author who wants to stop sooner.
 * It expires nothing, so stopping early is what creates the orphan.
 */
export function waitWindowMs(input: {
	/** Date.parse of the decision's expiresAt, or NaN when it never expires. */
	expiresAtMs: number
	intervalSec: number
	maxWaitMinutes?: number
	now?: number
}): number {
	const { expiresAtMs, intervalSec, maxWaitMinutes } = input;
	const now = input.now ?? Date.now();
	// One interval of grace, so the last poll lands after the server has expired
	// it and we report EXPIRED rather than giving up a tick early.
	const untilExpiry = Number.isFinite(expiresAtMs) ? expiresAtMs - now + intervalSec * 1000 : Number.NaN;
	const cap = maxWaitMinutes === undefined ? undefined : Math.max(1, maxWaitMinutes) * 60_000;
	// Never wait past the expiry: nothing can change after it.
	const window = Number.isFinite(untilExpiry)
		? Math.min(cap ?? Number.POSITIVE_INFINITY, untilExpiry)
		: (cap ?? 60 * 60_000); // never expires: fall back to an hour
	// Always poll at least once, even if the expiry has already passed.
	return Math.max(intervalSec * 1000, window);
}

/** A row of the Facts table, before coercion. */
interface FactRow {
	name?: string;
	type?: string;
	value?: unknown;
	showReviewer?: boolean;
	src?: string;
	description?: string;
}

/**
 * Coerce a row to the JSON type it declares. Expressions always arrive as
 * strings, so an array left as a string canonicalises to different bytes and
 * would never match at the action. The type selector is what keeps the asking
 * side and the acting side hashing the same thing.
 */
function coerceFact(row: FactRow, ctx: IExecuteFunctions, itemIndex: number): unknown {
	const raw = row.value;
	switch (row.type ?? 'string') {
		case 'number': {
			const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
			if (!Number.isFinite(n)) {
				throw new NodeOperationError(ctx.getNode(), `Fact "${row.name}" is not a number.`, { itemIndex });
			}
			return n;
		}
		case 'boolean':
			return typeof raw === 'boolean' ? raw : String(raw ?? '').trim().toLowerCase() === 'true';
		case 'array':
		case 'object': {
			if (typeof raw !== 'string') return raw;
			try {
				return JSON.parse(raw);
			} catch {
				throw new NodeOperationError(ctx.getNode(), `Fact "${row.name}" is not valid JSON.`, { itemIndex });
			}
		}
		default:
			return typeof raw === 'string' ? raw : String(raw ?? '');
	}
}

/**
 * Read a Facts table into the pair it feeds: every row is bound into the hash,
 * and the rows marked Show Reviewer are additionally sent as `context.data`
 * with their declared provenance. One source for both, so what the reviewer
 * saw and what the approval binds cannot drift apart.
 */
export function readFactsTable(
	ctx: IExecuteFunctions,
	itemIndex: number,
	param: string
): { facts: IDataObject; data: IDataObject } {
	const collection = ctx.getNodeParameter(param, itemIndex, {}) as IDataObject;
	const rows = (collection.fact ?? []) as FactRow[];
	const facts: IDataObject = {};
	const data: IDataObject = {};
	for (const row of rows) {
		const name = (row.name ?? '').trim();
		if (!name) continue;
		const value = coerceFact(row, ctx, itemIndex);
		facts[name] = value as IDataObject[string];
		if (row.showReviewer === false) continue;
		const src = row.src ?? 'unknown';
		const description = (row.description ?? '').trim();
		data[name] =
			description || src !== 'unknown'
				? ({ value, src, ...(description ? { description } : {}) } as IDataObject[string])
				: (value as IDataObject[string]);
	}
	return { facts, data };
}

/** Parse a JSON parameter that may arrive as a string or an object. Empty means none. */
function parseFacts(raw: unknown, ctx: IExecuteFunctions, itemIndex: number): IDataObject | undefined {
	if (raw === undefined || raw === null || raw === '' || raw === '{}') return undefined;
	if (typeof raw !== 'string') return raw as IDataObject;
	try {
		return JSON.parse(raw) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), 'Facts is not valid JSON.', { itemIndex });
	}
}

/**
 * Canonical JSON for facts: keys sorted at every level, plain JSON values only.
 * Must match Ratifia's `hashFacts` byte for byte, or every approval would look
 * like it covers different facts.
 */
export function canonicalFacts(value: unknown, path = 'facts'): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((v, i) => canonicalFacts(v, `${path}[${i}]`)).join(',')}]`;
	if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const obj = value as Record<string, unknown>;
		return `{${Object.keys(obj)
			.sort()
			.map((k) => {
				if (obj[k] === undefined) throw new Error(`${path}.${k} is undefined; omit the key or use null`);
				return `${JSON.stringify(k)}:${canonicalFacts(obj[k], `${path}.${k}`)}`;
			})
			.join(',')}}`;
	}
	throw new Error(`${path} must be plain JSON`);
}

/** Lowercase hex sha256 of the canonical facts. */
export function hashFacts(facts: IDataObject): string {
	return createHash('sha256').update(canonicalFacts(facts)).digest('hex');
}
