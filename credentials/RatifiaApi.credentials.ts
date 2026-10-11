import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Ratifia API credentials.
 *
 * One org API key, created in the dashboard under API Keys. The key is shown
 * once and stored hashed on our side, so it cannot be recovered later: if it is
 * lost, rotate it rather than looking it up.
 */
export class RatifiaApi implements ICredentialType {
	name = 'ratifiaApi';

	displayName = 'Ratifia API';

	icon: Icon = 'file:../nodes/Ratifia/ratifia.svg';

	documentationUrl = 'https://docs.ratifia.com/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Org API key from the Ratifia dashboard under API Keys. Scoped to one organization, so it determines whose policies and approvers apply.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.ratifia.com',
			required: true,
			description:
				'Leave at the default unless Ratifia gives you a different endpoint',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * Credential test. Lists decisions rather than hitting /health, because
	 * /health answers without authenticating: it would report success for a key
	 * that is revoked, malformed or belongs to another environment.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/worker/decisions',
			method: 'GET',
		},
	};
}
