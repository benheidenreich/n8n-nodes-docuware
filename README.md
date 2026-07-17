# @benheidenreich/n8n-nodes-docuware

This is an n8n community node. It lets you use [DocuWare](https://docuware.com) in your n8n workflows.

DocuWare is a document management system (DMS) for archiving, indexing and retrieving business documents such as invoices, contracts and HR files.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

Package name: `@benheidenreich/n8n-nodes-docuware`

## Operations

**Document**

- Upload — store a file with index fields in any file cabinet
- Get — get the metadata of a document
- Search — search documents by index fields
- Update Fields — update the index fields of an existing document
- Delete — delete a document

**File Cabinet**

- Get Many — list all file cabinets of the organization

The field structure of the selected file cabinet is loaded automatically from DocuWare — no manual field mapping is required. In the recommended "Auto From Input Data" mode, all properties of the input item are matched case-insensitively against the cabinet's field names.

## Credentials

You need a DocuWare user with access to the DocuWare Platform API.

1. In n8n, create new **DocuWare API** credentials.
2. Enter the **Server URL** of your DocuWare installation (cloud or on-premises), e.g. `https://your-company.docuware.cloud`.
3. Enter the **Username** and **Password** of the DocuWare user.

Authentication uses the official DocuWare Identity Service (OAuth 2.0 password flow). Tokens are cached and refreshed automatically.

## Compatibility

- Requires n8n running on Node.js 18.10 or newer.
- Tested against DocuWare Cloud and DocuWare on-premises 7.8+ (Platform API with Identity Service).

## Usage

1. Add the **DocuWare** node to a workflow and select your credentials.
2. Pick a **File Cabinet** from the dropdown — the list and all field names are loaded live from your DocuWare installation.
3. For **Upload**, provide the file in a binary field (default `data`) and choose a fields input mode:
   - **Auto From Input Data** (recommended): name the JSON properties of the input item like the cabinet's field DB names (e.g. with a preceding Set node) — they are matched automatically.
   - **JSON**: pass an object like `{ "INVOICE_NUMBER": "RE-123", "AMOUNT": 199.9 }`.
   - **Manually Select**: pick fields via dropdowns.
4. Field data types (text, integer, decimal, date, keywords) are detected automatically from the cabinet definition; dates accept `yyyy-MM-dd` or ISO 8601.

An importable example workflow is included in [`examples/beispiel-workflow.json`](examples/beispiel-workflow.json).

To target different cabinets dynamically, switch the File Cabinet parameter to an expression and pass a cabinet ID, e.g. `{{ $json.targetCabinetId }}`. Use the File Cabinet → Get Many operation once to list all cabinet IDs.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [DocuWare Platform API documentation](https://developer.docuware.com/rest/index.html)

## Version history

- **0.1.1** — Maintenance release: publishing moved to tokenless npm Trusted Publishing (OIDC); no functional changes.
- **0.1.0** — Initial release: document upload, get, search, update fields, delete; file cabinet listing; automatic field detection with auto/JSON/manual input modes.
