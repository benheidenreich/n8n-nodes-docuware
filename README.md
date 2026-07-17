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
- Get Fields — list the index fields of a cabinet (DB name, display name, data type) and generate a ready-to-copy JSON template for the upload

The field structure of the selected file cabinet is loaded automatically from DocuWare — no manual field mapping is required. In the recommended "Auto From Input Data" mode, all properties of the input item are matched case-insensitively against the cabinet's field names.

## Credentials

You need a DocuWare user with access to the DocuWare Platform API.

1. In n8n, create new **DocuWare API** credentials.
2. Enter the **Server URL** of your DocuWare installation (cloud or on-premises), e.g. `https://your-company.docuware.cloud`.
3. Enter the **Username** and **Password** of the DocuWare user.

Authentication uses the official DocuWare Identity Service (OAuth 2.0 password flow). Tokens are cached and refreshed automatically.

Two things to know:

- The built-in **credential test only checks that the server URL is reachable** — username and password are verified on the first node execution, so login errors show up there, not in the credential dialog.
- A **dedicated API user** with password login is recommended. Accounts that only sign in via SSO may not work with the password flow.

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
4. Field data types (text, integer, decimal, date, keywords) are detected automatically from the cabinet definition.

An importable example workflow is included in [`examples/beispiel-workflow.json`](examples/beispiel-workflow.json): Form Trigger (PDF upload) → Edit Fields (index values as raw JSON) → DocuWare Upload in auto mode. It also contains a standalone Get Fields node for fetching the JSON template (workflow A below).

To target different cabinets dynamically, switch the File Cabinet parameter to an expression and pass a cabinet ID, e.g. `{{ $json.targetCabinetId }}`. Use the File Cabinet → Get Many operation once to list all cabinet IDs.

### Building the index JSON with "Get Fields"

The File Cabinet → **Get Fields** operation shows which index fields a cabinet has (DB name, display name, data type) and can output a ready-made JSON template. There are two ways to use it:

**A — At design time (the normal case):**

1. Drop a Get Fields node loosely onto the canvas, select the cabinet and execute it once with output **JSON Template**.
2. Copy the `jsonTemplate` output — it contains every index field with a type-appropriate example value.
3. Paste it into the Set/Edit Fields node before your Upload node (raw JSON mode) and replace the example values with real values or expressions.
4. Delete or deactivate the Get Fields node. The production chain stays: Trigger → Set → Upload.

The Upload node fetches the cabinet's field list itself at runtime (auto matching + type conversion) — Get Fields does **not** need to be part of the production chain.

**B — At runtime (dynamic scenarios only):**

Trigger → Get Fields (output **Field List**) → Code node (map your source data against the field list dynamically) → Upload. This only makes sense for changing cabinets or generic workflows and costs one extra API call per execution. Careful with binary data passing through the intermediate nodes: Set/Edit Fields v3.4+ drops binary data unless "Include Other Input Fields" is enabled and "Strip Binary Data" is disabled.

### Field values: dates and keywords

- **Dates** accept ISO 8601 (`2026-01-01T12:00:00Z`), `yyyy-MM-dd`, any JS-parseable date string, or the raw DocuWare format `/Date(ms)/`. Conversion to `/Date(ms)/` happens automatically in every input mode (auto, JSON, manual).
- **Keywords** fields expect an **array**: `{ "TAGS": ["A", "B"] }` stores two keywords. A comma-separated string like `"A,B"` is stored as a *single* keyword — without an error.

### Chaining operations

With **Simplify** enabled (default), the Search output is a flat object including `DWDOCID` — it can be fed directly into Update Fields or Delete by setting Document ID to the expression `{{ $json.DWDOCID }}`. Search values match exactly; use `*` as a wildcard for contains searches, e.g. `*rechnung*`.

### Use as an AI Agent tool

The node is marked as `usableAsTool` — it can be attached to an n8n **AI Agent** as a tool. The agent can then upload, search, update or delete DocuWare documents on its own; parameter values can be filled from the model via `$fromAI`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [DocuWare Platform API documentation](https://developer.docuware.com/rest/index.html)

## Version history

- **0.2.0** — New File Cabinet → Get Fields operation (field list + copyable JSON template); clearer error when the input binary field is missing (lists the fields that are present) and when Update Fields finds nothing to update; many new hints (wildcards in Search, Document ID origin, keywords array semantics, date formats, Set-node binary pitfall, credential test scope); example workflow rebuilt around Form Trigger → Edit Fields → Upload.
- **0.1.2** — Bugfix: index fields arrived empty in DocuWare because the cabinet field list was filtered on a non-existent property (`UserDefined`/`DBName` instead of `Scope`/`DBFieldName`). Auto/JSON/manual field matching works reliably now.
- **0.1.1** — Maintenance release: publishing moved to tokenless npm Trusted Publishing (OIDC); no functional changes.
- **0.1.0** — Initial release: document upload, get, search, update fields, delete; file cabinet listing; automatic field detection with auto/JSON/manual input modes.
