import type {
	GenericValue,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

interface FieldMeta {
	dbName: string;
	displayName: string;
	dwType: string;
}

interface ManualFieldEntry {
	fieldName: string;
	type: string;
	value: string;
}

// Token cache per server+user so the node does not re-authenticate on every
// request. Lives as long as the n8n process.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function getServerUrl(credentials: IDataObject): string {
	return String(credentials.serverUrl ?? '').replace(/\/+$/, '');
}

/**
 * Fetches an access token via the DocuWare Identity Service
 * (resource owner password flow, the official DocuWare authentication).
 */
async function getDocuWareAccessToken(
	this: Context,
	credentials: IDataObject,
	forceRefresh = false,
): Promise<string> {
	const serverUrl = getServerUrl(credentials);
	const cacheKey = `${serverUrl}|${credentials.username}`;

	if (!forceRefresh) {
		const cached = tokenCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.accessToken;
		}
	}

	try {
		const identityInfo = (await this.helpers.httpRequest({
			method: 'GET',
			url: `${serverUrl}/DocuWare/Platform/Home/IdentityServiceInfo`,
			headers: { Accept: 'application/json' },
			json: true,
		})) as IDataObject;

		const identityServiceUrl = String(identityInfo.IdentityServiceUrl ?? '').replace(/\/+$/, '');
		const oidcConfig = (await this.helpers.httpRequest({
			method: 'GET',
			url: `${identityServiceUrl}/.well-known/openid-configuration`,
			json: true,
		})) as IDataObject;

		const tokenResponse = (await this.helpers.httpRequest({
			method: 'POST',
			url: String(oidcConfig.token_endpoint),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'password',
				scope: 'docuware.platform',
				client_id: 'docuware.platform.net.client',
				username: String(credentials.username),
				password: String(credentials.password),
			}).toString(),
			json: true,
		})) as IDataObject;

		const expiresInMs = (Number(tokenResponse.expires_in) || 3600) * 1000;
		const accessToken = String(tokenResponse.access_token);
		tokenCache.set(cacheKey, {
			accessToken,
			// 60 second safety buffer before expiry
			expiresAt: Date.now() + expiresInMs - 60_000,
		});

		return accessToken;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error, {
			message: 'DocuWare authentication failed',
			description:
				'Check the server URL, username and password in the credentials. The user needs access to the DocuWare Platform API.',
		});
	}
}

/**
 * Central request against the DocuWare Platform API. Supports JSON bodies and
 * multipart uploads (FormData). On a 401 response the token is refreshed once
 * and the request retried (JSON requests only — a FormData stream cannot be
 * replayed).
 */
async function docuWareApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject | FormData = {},
	qs: IDataObject = {},
	isRetry = false,
): Promise<unknown> {
	const credentials = await this.getCredentials('docuWareApi');
	const serverUrl = getServerUrl(credentials);
	const accessToken = await getDocuWareAccessToken.call(this, credentials, isRetry);

	const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

	const options: IHttpRequestOptions = {
		method,
		url: `${serverUrl}${endpoint}`,
		qs,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
		},
	};

	if (isFormData) {
		options.body = body;
	} else {
		options.json = true;
		if (Object.keys(body as IDataObject).length > 0) {
			options.body = body;
		}
	}

	try {
		return await this.helpers.httpRequest(options);
	} catch (error) {
		const statusCode =
			error.httpCode ?? error.response?.status ?? error.response?.statusCode ?? error.statusCode;
		if (!isRetry && !isFormData && String(statusCode) === '401') {
			return docuWareApiRequest.call(this, method, endpoint, body, qs, true);
		}
		throw new NodeApiError(this.getNode(), error);
	}
}

// DocuWare field type (DWFieldType) → ItemElementName in the field JSON
const DW_TYPE_TO_ELEMENT: Record<string, string> = {
	Text: 'String',
	Memo: 'String',
	Numeric: 'Int',
	Decimal: 'Decimal',
	Date: 'Date',
	DateTime: 'DateTime',
	Keywords: 'Keywords',
};

/**
 * A cabinet field counts as user-defined when Scope is "user" (Platform REST
 * response). Older payload variants exposing UserDefined/SystemField are
 * handled as fallback. The field name lives in DBFieldName (DBName as legacy
 * fallback).
 */
function isUserField(field: IDataObject): boolean {
	if (field.Scope !== undefined) return String(field.Scope).toLowerCase() === 'user';
	if (field.UserDefined !== undefined) return field.UserDefined === true;
	return field.SystemField !== true;
}

/**
 * Loads the user-defined index fields of a file cabinet (cached per execution)
 * as a map: DBNAME (uppercase) → field metadata.
 */
async function getCabinetFieldMeta(
	this: IExecuteFunctions,
	fileCabinetId: string,
	cache: Map<string, Map<string, FieldMeta>>,
): Promise<Map<string, FieldMeta>> {
	const cached = cache.get(fileCabinetId);
	if (cached) return cached;

	const response = (await docuWareApiRequest.call(
		this,
		'GET',
		`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}`,
	)) as IDataObject;

	const meta = new Map<string, FieldMeta>();
	for (const field of (response.Fields as IDataObject[]) ?? []) {
		if (!isUserField(field)) continue;
		const dbName = field.DBFieldName ?? field.DBName;
		meta.set(String(dbName).toUpperCase(), {
			dbName: String(dbName),
			displayName: String(field.DisplayName ?? dbName),
			dwType: String(field.DWFieldType ?? 'Text'),
		});
	}

	cache.set(fileCabinetId, meta);
	return meta;
}

/**
 * Converts a raw value into the item format DocuWare expects. Date values are
 * translated into the DocuWare JSON date format /Date(ms)/.
 */
function convertFieldValue(
	node: INode,
	itemIndex: number,
	fieldName: string,
	rawValue: unknown,
	elementName: string,
): unknown {
	switch (elementName) {
		case 'Int': {
			const intValue = Number.parseInt(String(rawValue), 10);
			if (Number.isNaN(intValue)) {
				throw new NodeOperationError(
					node,
					`Field "${fieldName}": "${rawValue}" isn't a valid integer`,
					{ itemIndex },
				);
			}
			return intValue;
		}
		case 'Decimal': {
			const decValue = Number.parseFloat(String(rawValue));
			if (Number.isNaN(decValue)) {
				throw new NodeOperationError(
					node,
					`Field "${fieldName}": "${rawValue}" isn't a valid decimal number`,
					{ itemIndex },
				);
			}
			return decValue;
		}
		case 'Date':
		case 'DateTime': {
			if (typeof rawValue === 'string' && /^\/Date\(-?\d+\)\/$/.test(rawValue)) {
				return rawValue;
			}
			const date = rawValue instanceof Date ? rawValue : new Date(String(rawValue));
			if (Number.isNaN(date.getTime())) {
				throw new NodeOperationError(
					node,
					`Field "${fieldName}": "${rawValue}" isn't a valid date (expected e.g. yyyy-MM-dd or ISO 8601)`,
					{ itemIndex },
				);
			}
			return `/Date(${date.getTime()})/`;
		}
		case 'Keywords': {
			const values = Array.isArray(rawValue) ? rawValue : [rawValue];
			return { Keyword: values.map((v) => String(v)) };
		}
		default:
			return String(rawValue);
	}
}

/**
 * Builds the Fields array for upload/updateFields from the selected input mode
 * (auto / json / manual).
 */
async function resolveIndexFields(
	this: IExecuteFunctions,
	fileCabinetId: string,
	itemIndex: number,
	cache: Map<string, Map<string, FieldMeta>>,
): Promise<IDataObject[]> {
	const node = this.getNode();
	const fieldsMode = this.getNodeParameter('fieldsMode', itemIndex, 'auto') as string;
	const fieldMeta = await getCabinetFieldMeta.call(this, fileCabinetId, cache);

	const lookupField = (name: string): FieldMeta | undefined => {
		const key = String(name).toUpperCase();
		const direct = fieldMeta.get(key);
		if (direct) return direct;
		for (const entry of fieldMeta.values()) {
			if (entry.displayName.toUpperCase() === key) return entry;
		}
		return undefined;
	};

	const buildField = (
		metaEntry: FieldMeta,
		rawValue: unknown,
		explicitElementName?: string,
	): IDataObject => {
		const elementName = explicitElementName ?? DW_TYPE_TO_ELEMENT[metaEntry.dwType] ?? 'String';
		return {
			FieldName: metaEntry.dbName,
			Item: convertFieldValue(node, itemIndex, metaEntry.dbName, rawValue, elementName) as
				| GenericValue
				| IDataObject,
			ItemElementName: elementName,
		};
	};

	// ---------- Auto: match input properties against cabinet fields ----------
	if (fieldsMode === 'auto') {
		const inputJson = this.getInputData()[itemIndex].json ?? {};
		const fields: IDataObject[] = [];
		for (const [key, value] of Object.entries(inputJson)) {
			if (value === null || value === undefined || value === '') continue;
			const metaEntry = lookupField(key);
			if (!metaEntry) continue; // non-matching properties are ignored by design
			fields.push(buildField(metaEntry, value));
		}
		return fields;
	}

	// ---------- JSON: explicit object { DBNAME: value } ----------
	if (fieldsMode === 'json') {
		let fieldsObject = this.getNodeParameter('fieldsJson', itemIndex, {}) as
			| string
			| IDataObject;
		if (typeof fieldsObject === 'string') {
			try {
				fieldsObject = fieldsObject.trim() === '' ? {} : (JSON.parse(fieldsObject) as IDataObject);
			} catch (error) {
				throw new NodeOperationError(node, 'Fields (JSON) doesn\'t contain valid JSON', {
					description: (error as Error).message,
					itemIndex,
				});
			}
		}
		if (fieldsObject === null || typeof fieldsObject !== 'object' || Array.isArray(fieldsObject)) {
			throw new NodeOperationError(
				node,
				'Fields (JSON) must be an object of the form { "DBNAME": "value" }',
				{ itemIndex },
			);
		}

		const fields: IDataObject[] = [];
		for (const [key, value] of Object.entries(fieldsObject)) {
			if (value === null || value === undefined || value === '') continue;
			const metaEntry = lookupField(key);
			if (!metaEntry) {
				const available = [...fieldMeta.values()].map((f) => f.dbName).join(', ');
				throw new NodeOperationError(
					node,
					`Field "${key}" doesn't exist in the selected file cabinet`,
					{ description: `Available fields: ${available}`, itemIndex },
				);
			}
			fields.push(buildField(metaEntry, value));
		}
		return fields;
	}

	// ---------- Manual: fixedCollection ----------
	const fieldsParam = this.getNodeParameter('fields', itemIndex, {}) as IDataObject;
	const fields: IDataObject[] = [];
	for (const entry of (fieldsParam.field as ManualFieldEntry[]) ?? []) {
		if (!entry.fieldName) continue;
		const metaEntry = lookupField(entry.fieldName);
		if (!metaEntry) {
			throw new NodeOperationError(
				node,
				`Field "${entry.fieldName}" doesn't exist in the selected file cabinet`,
				{ itemIndex },
			);
		}
		const explicitElementName = entry.type && entry.type !== 'auto' ? entry.type : undefined;
		fields.push(buildField(metaEntry, entry.value, explicitElementName));
	}
	return fields;
}

/** Converts DocuWare date strings (/Date(ms)/) back to ISO 8601. */
function parseDocuWareDate(value: unknown): unknown {
	const match = /^\/Date\((-?\d+)\)\/$/.exec(String(value));
	if (!match) return value;
	return new Date(Number(match[1])).toISOString();
}

/** Simplifies a search result item: Fields array → flat object. */
function simplifySearchResult(item: IDataObject): IDataObject {
	const simplified: IDataObject = {};
	for (const field of (item.Fields as IDataObject[]) ?? []) {
		let value: unknown = field.Item;
		if ((field.ItemElementName === 'Date' || field.ItemElementName === 'DateTime') && value != null) {
			value = parseDocuWareDate(value);
		}
		if (value && typeof value === 'object' && Array.isArray((value as IDataObject).Keyword)) {
			value = (value as IDataObject).Keyword;
		}
		simplified[String(field.FieldName)] = value as GenericValue | IDataObject;
	}
	if (item.Id !== undefined && simplified.DWDOCID === undefined) {
		simplified.DWDOCID = item.Id;
	}
	return simplified;
}

export class DocuWare implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DocuWare',
		name: 'docuWare',
		icon: 'file:docuware.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Upload, search and manage documents in DocuWare',
		defaults: { name: 'DocuWare' },
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'docuWareApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Document', value: 'document' },
					{ name: 'File Cabinet', value: 'fileCabinet' },
				],
				default: 'document',
			},

			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['document'] } },
				options: [
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a document from a file cabinet',
						action: 'Delete a document',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get the metadata of a document',
						action: 'Get a document',
					},
					{
						name: 'Search',
						value: 'search',
						description: 'Search documents by index fields',
						action: 'Search documents',
					},
					{
						name: 'Update Fields',
						value: 'updateFields',
						description: 'Update the index fields of an existing document',
						action: 'Update index fields of a document',
					},
					{
						name: 'Upload',
						value: 'upload',
						description: 'Store a file with index fields in a file cabinet',
						action: 'Upload a document',
					},
				],
				default: 'upload',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['fileCabinet'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List many file cabinets of the organization',
						action: 'Get many file cabinets',
					},
				],
				default: 'getAll',
			},

			{
				displayName: 'File Cabinet Name or ID',
				name: 'fileCabinetId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getFileCabinets' },
				required: true,
				displayOptions: {
					show: {
						resource: ['document'],
						operation: ['upload', 'get', 'search', 'updateFields', 'delete'],
					},
				},
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},

			{
				displayName: 'Store Dialog Name or ID',
				name: 'storeDialogId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getStoreDialogs',
					loadOptionsDependsOn: ['fileCabinetId'],
				},
				displayOptions: { show: { resource: ['document'], operation: ['upload'] } },
				default: '',
				description:
					'Optional store dialog used for indexing. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { resource: ['document'], operation: ['upload'] } },
				hint: 'The name of the input binary field containing the file to be uploaded',
			},

			{
				displayName: 'Fields Input Mode',
				name: 'fieldsMode',
				type: 'options',
				options: [
					{
						name: 'Auto From Input Data (Recommended)',
						value: 'auto',
						description:
							'All properties of the input item are matched automatically against the field names of the selected file cabinet — works for any cabinet without configuration',
					},
					{
						name: 'JSON',
						value: 'json',
						description: 'Provide the fields as a JSON object { "DBNAME": "value", ... }, e.g. via an expression from a previous node.',
					},
					{
						name: 'Manually Select',
						value: 'manual',
						description: 'Pick fields directly in this node via dropdowns (for individual cases)',
					},
				],
				default: 'auto',
				displayOptions: {
					show: { resource: ['document'], operation: ['upload', 'updateFields'] },
				},
			},

			{
				displayName:
					'All properties of the input item are matched automatically against the field names of the selected file cabinet (case-insensitive). Non-matching properties are ignored. Define the structure with a preceding "Set" or "Code" node.',
				name: 'autoModeNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						resource: ['document'],
						operation: ['upload', 'updateFields'],
						fieldsMode: ['auto'],
					},
				},
			},

			{
				displayName: 'Fields (JSON)',
				name: 'fieldsJson',
				type: 'json',
				default: '{}',
				placeholder: '{\n  "FIELD_NAME_1": "value",\n  "FIELD_NAME_2": 123\n}',
				description:
					'JSON object mapping the DB name of each field to its value. The data type is detected automatically from the selected file cabinet.',
				displayOptions: {
					show: {
						resource: ['document'],
						operation: ['upload', 'updateFields'],
						fieldsMode: ['json'],
					},
				},
			},

			{
				displayName: 'Index Fields',
				name: 'fields',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Field',
				displayOptions: {
					show: {
						resource: ['document'],
						operation: ['upload', 'updateFields'],
						fieldsMode: ['manual'],
					},
				},
				options: [
					{
						name: 'field',
						displayName: 'Field',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'fieldName',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getFileCabinetFields',
									loadOptionsDependsOn: ['fileCabinetId'],
								},
								default: '',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{ name: 'Auto (Detect From File Cabinet)', value: 'auto' },
									{ name: 'Date', value: 'Date' },
									{ name: 'Date & Time', value: 'DateTime' },
									{ name: 'Decimal Number', value: 'Decimal' },
									{ name: 'Integer', value: 'Int' },
									{ name: 'Keywords', value: 'Keywords' },
									{ name: 'Text', value: 'String' },
								],
								default: 'auto',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Dates in the format yyyy-MM-dd or yyyy-MM-ddTHH:mm:ss',
							},
						],
					},
				],
			},

			{
				displayName: 'Document ID',
				name: 'documentId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: { resource: ['document'], operation: ['get', 'updateFields', 'delete'] },
				},
			},

			{
				displayName: 'Search Dialog ID',
				name: 'searchDialogId',
				type: 'string',
				default: '',
				description: "Optional — leave empty to use the file cabinet's default search dialog",
				displayOptions: { show: { resource: ['document'], operation: ['search'] } },
			},
			{
				displayName: 'Search Conditions',
				name: 'conditions',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Condition',
				displayOptions: { show: { resource: ['document'], operation: ['search'] } },
				options: [
					{
						name: 'condition',
						displayName: 'Condition',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'dbName',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getFileCabinetFields',
									loadOptionsDependsOn: ['fileCabinetId'],
								},
								default: '',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['document'], operation: ['search'] } },
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return a simplified version of the response instead of the raw data',
				displayOptions: { show: { resource: ['document'], operation: ['search'] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async getFileCabinets(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = (await docuWareApiRequest.call(
					this,
					'GET',
					'/DocuWare/Platform/FileCabinets',
				)) as IDataObject;
				const cabinets = (response.FileCabinet as IDataObject[]) ?? [];
				return cabinets
					.filter((c) => c.IsBasket !== true)
					.map((c) => ({ name: String(c.Name), value: String(c.Id) }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getStoreDialogs(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const fileCabinetId = this.getCurrentNodeParameter('fileCabinetId') as string;
				if (!fileCabinetId) return [];
				const response = (await docuWareApiRequest.call(
					this,
					'GET',
					`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}/Dialogs`,
					{},
					{ DialogType: 'Store' },
				)) as IDataObject;
				const dialogs = (response.Dialog as IDataObject[]) ?? [];
				return dialogs
					.map((d) => ({ name: String(d.DisplayName), value: String(d.Id) }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getFileCabinetFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const fileCabinetId = this.getCurrentNodeParameter('fileCabinetId') as string;
				if (!fileCabinetId) return [];
				const response = (await docuWareApiRequest.call(
					this,
					'GET',
					`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}`,
				)) as IDataObject;
				const fields = (response.Fields as IDataObject[]) ?? [];
				return fields
					.filter((f) => isUserField(f))
					.map((f) => {
						const dbName = String(f.DBFieldName ?? f.DBName);
						return { name: `${f.DisplayName ?? dbName} (${dbName})`, value: dbName };
					})
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Shared cache for field metadata across all items (per execution)
		const cabinetFieldsCache = new Map<string, Map<string, FieldMeta>>();

		for (let i = 0; i < items.length; i++) {
			try {
				// ================= FILE CABINET =================
				if (resource === 'fileCabinet' && operation === 'getAll') {
					const response = (await docuWareApiRequest.call(
						this,
						'GET',
						'/DocuWare/Platform/FileCabinets',
					)) as IDataObject;
					for (const cabinet of (response.FileCabinet as IDataObject[]) ?? []) {
						returnData.push({ json: cabinet, pairedItem: { item: i } });
					}
					continue;
				}

				// ================= DOCUMENT: UPLOAD =================
				if (resource === 'document' && operation === 'upload') {
					const fileCabinetId = this.getNodeParameter('fileCabinetId', i) as string;
					const storeDialogId = this.getNodeParameter('storeDialogId', i, '') as string;
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;

					const indexFields = await resolveIndexFields.call(
						this,
						fileCabinetId,
						i,
						cabinetFieldsCache,
					);

					const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
					const fileBuffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);

					const formData = new FormData();
					formData.append(
						'Document',
						new Blob([JSON.stringify({ Fields: indexFields })], { type: 'application/json' }),
						'Index.json',
					);
					formData.append(
						'File[]',
						new Blob([new Uint8Array(fileBuffer)], {
							type: binaryData.mimeType || 'application/octet-stream',
						}),
						binaryData.fileName || 'document.pdf',
					);

					const qs: IDataObject = {};
					if (storeDialogId) qs.StoreDialogId = storeDialogId;

					const response = (await docuWareApiRequest.call(
						this,
						'POST',
						`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}/Documents`,
						formData,
						qs,
					)) as IDataObject;

					returnData.push({ json: response, pairedItem: { item: i } });
					continue;
				}

				// ================= DOCUMENT: GET =================
				if (resource === 'document' && operation === 'get') {
					const fileCabinetId = this.getNodeParameter('fileCabinetId', i) as string;
					const documentId = this.getNodeParameter('documentId', i) as string;
					const response = (await docuWareApiRequest.call(
						this,
						'GET',
						`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}/Documents/${encodeURIComponent(documentId)}`,
					)) as IDataObject;
					returnData.push({ json: response, pairedItem: { item: i } });
					continue;
				}

				// ================= DOCUMENT: UPDATE FIELDS =================
				if (resource === 'document' && operation === 'updateFields') {
					const fileCabinetId = this.getNodeParameter('fileCabinetId', i) as string;
					const documentId = this.getNodeParameter('documentId', i) as string;

					const fieldArray = await resolveIndexFields.call(
						this,
						fileCabinetId,
						i,
						cabinetFieldsCache,
					);
					if (fieldArray.length === 0) {
						throw new NodeOperationError(this.getNode(), 'No index fields to update found', {
							description:
								'In auto mode the input item must contain at least one property matching a field of the file cabinet.',
							itemIndex: i,
						});
					}

					const response = (await docuWareApiRequest.call(
						this,
						'PUT',
						`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}/Documents/${encodeURIComponent(documentId)}/Fields`,
						{ Field: fieldArray },
					)) as IDataObject;
					returnData.push({ json: response, pairedItem: { item: i } });
					continue;
				}

				// ================= DOCUMENT: DELETE =================
				if (resource === 'document' && operation === 'delete') {
					const fileCabinetId = this.getNodeParameter('fileCabinetId', i) as string;
					const documentId = this.getNodeParameter('documentId', i) as string;
					await docuWareApiRequest.call(
						this,
						'DELETE',
						`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}/Documents/${encodeURIComponent(documentId)}`,
					);
					returnData.push({ json: { success: true, documentId }, pairedItem: { item: i } });
					continue;
				}

				// ================= DOCUMENT: SEARCH =================
				if (resource === 'document' && operation === 'search') {
					const fileCabinetId = this.getNodeParameter('fileCabinetId', i) as string;
					const searchDialogId = this.getNodeParameter('searchDialogId', i, '') as string;
					const conditionsParam = this.getNodeParameter('conditions', i, {}) as IDataObject;
					const limit = this.getNodeParameter('limit', i) as number;
					const simplify = this.getNodeParameter('simplify', i, true) as boolean;

					const conditionArray = (((conditionsParam.condition as IDataObject[]) ?? [])
						.filter((c) => c.dbName) as IDataObject[]).map((c) => ({
						DBName: c.dbName,
						Value: [c.value],
					}));

					const qs: IDataObject = { Count: limit };
					if (searchDialogId) qs.DialogId = searchDialogId;

					const response = (await docuWareApiRequest.call(
						this,
						'POST',
						`/DocuWare/Platform/FileCabinets/${encodeURIComponent(fileCabinetId)}/Query/DialogExpression`,
						{ Condition: conditionArray, Operation: 'And' },
						qs,
					)) as IDataObject;

					for (const doc of (response.Items as IDataObject[]) ?? []) {
						returnData.push({
							json: simplify ? simplifySearchResult(doc) : doc,
							pairedItem: { item: i },
						});
					}
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					`Unknown operation "${operation}" for resource "${resource}"`,
					{ itemIndex: i },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: error.message }, pairedItem: { item: i } });
					continue;
				}
				if (error.context) {
					error.context.itemIndex = i;
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
