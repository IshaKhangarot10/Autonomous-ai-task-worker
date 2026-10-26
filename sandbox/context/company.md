# Acme Corp — Finance Department Procedures

## Invoice Processing

All invoices received via email or other channels must be logged into
the **Acme Finance Portal** at: http://localhost:4000

### Required Fields

When creating an invoice entry, the following fields are mandatory:

- **Vendor**: Select the vendor from the dropdown. The vendor must
  already exist in the system.
- **Invoice Number**: Enter the exact invoice number from the document.
  This is the primary identifier and must be unique.
- **Amount**: Enter the numeric amount as shown on the invoice, in the
  invoice's own currency. Remove currency symbols and formatting.
- **Currency**: Select INR or USD to match the invoice.
- **Due Date**: Enter the payment due date from the invoice.

### Duplicate Invoices

**Never create a duplicate invoice.** Before entering an invoice, check
whether its invoice number already exists in the system. If the invoice
has already been logged, do **not** create another entry. Instead,
report that the invoice already exists and include the existing record
details.

### Vendor Records

Vendor records can be viewed and edited at the Vendors page. When
updating vendor information (e.g., billing email), ensure the new
information is accurate.

### Approval Requirements

Any action that **creates, edits, or deletes** a record in the portal
requires **human approval** before execution. This includes:

- Creating a new invoice entry
- Updating vendor information
- Any other write operation

Read-only operations (viewing, searching, reading files) do not require
approval.

### Portal Access

Portal login credentials are managed by the system. The AI assistant
does not need to know or handle passwords directly — authentication is
handled automatically by the runtime environment.

### Data Accuracy

- Enter amounts exactly as stated on the invoice document.
- Use the currency specified on the invoice (INR or USD).
- Dates should be entered in the format expected by the portal
  (YYYY-MM-DD).
- Do not invent or assume data that is not present in the source
  document.
- If information is ambiguous or unclear, ask for clarification before
  proceeding.
