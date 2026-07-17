import type {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DocuWareApi implements ICredentialType {
	name = 'docuWareApi';

	displayName = 'DocuWare API';

	documentationUrl = 'https://developer.docuware.com/rest/index.html';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: '',
			placeholder: 'https://your-company.docuware.cloud',
			description:
				'Base URL of your DocuWare installation (cloud or on-premises), without a trailing slash',
			required: true,
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName:
				'Note: the credential test only checks that the server URL points to a reachable DocuWare Platform. Username and password are verified on the first node execution — login errors show up there, not here. A dedicated API user with password login is recommended; SSO-only accounts may not work with this flow.',
			name: 'credentialTestNotice',
			type: 'notice',
			default: '',
		},
	];

	// Validates that the server URL points to a reachable DocuWare Platform.
	// Username/password are verified on the first node execution (token flow).
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl}}',
			url: '/DocuWare/Platform/Home/IdentityServiceInfo',
			method: 'GET',
		},
	};
}
