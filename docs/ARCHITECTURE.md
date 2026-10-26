# CentrAlign AI — System Architecture & Run Walkthrough

This document provides an in-depth walkthrough of the CentrAlign Autonomous AI Task Worker architecture, detailing the lifecycle of a complete task run step-by-step with a comprehensive Mermaid sequence diagram, state transitions, security boundaries, and interview explanations.

---

## Complete End-to-End Run Sequence Diagram

The following sequence diagram illustrates the exact flow of **Task 1** ("Find the latest invoice from Globex, extract the amount and due date, enter it into the finance portal, and tell me once it is done"):

```mermaid
sequenceDiagram
    autonumber
    actor User as Supervisor (Dashboard / CLI)
    participant Server as Agent Server (:4001)
    participant Loop as Runtime Loop (loop.js)
    participant LLM as Google Gemini 2.0 Flash
    participant Reg as Tool Registry
    participant Policy as Policy Layer (policy.js)
    participant Browser as Playwright Browser
    participant Files as Sandboxed Files
    participant Verifier as Independent Verifier
    participant Portal as Acme Finance Portal (:4000)
    participant DB as MongoDB (agent_runs DB)

    %% 1. Initiation
    User->>Server: POST /api/runs { goal: "Find latest Globex invoice..." }
    Server->>DB: Run.create({ status: "running", goal })
    Server-->>User: 202 Accepted { runId }
    User->>Server: GET /api/runs/:runId/events (SSE Stream)

    %% 2. Understand & Plan
    Loop->>Files: list_files({ dir: "sandbox/inbox" })
    Files-->>Loop: [globex_original.txt, globex_resubmission.txt, ...]
    Loop->>Files: read_file({ path: "sandbox/context/company.md" })
    Files-->>Loop: Company procedures (Portal URL, credentials, no duplicates)
    Loop->>LLM: Goal + Context + Tools -> Prompt
    LLM-->>Loop: ToolCall: update_plan([Steps 1..5])
    Loop->>Server: SSE: plan_updated
    Server-->>User: Live Checklist Updated

    %% 3. Document Reasoning & Memory
    Loop->>Files: read_file({ path: "sandbox/inbox/globex_resubmission.txt" })
    Files-->>Loop: "Date: September 15, 2024"
    Loop->>Files: read_file({ path: "sandbox/inbox/globex_original.txt" })
    Files-->>Loop: "Date: October 20, 2024" (Newer!)
    Loop->>LLM: Documents Content
    LLM-->>Loop: ToolCall: remember({ invoice_number: "GLX-2024-0112", amount: 4850, dueDate: "2024-11-20" })
    Loop->>Server: SSE: memory_updated

    %% 4. Browser Automation & Dynamic Snapshot
    Loop->>Browser: browser_navigate({ url: "http://localhost:4000/invoices" })
    Loop->>Browser: browser_login({ site: "portal" })
    Note over Browser,Portal: Runtime fills credentials from .env.<br/>Password is NEVER leaked to LLM.
    Browser->>Portal: POST /login (demo / demo123)
    Portal-->>Browser: 302 Redirect /invoices
    Loop->>Browser: browser_navigate({ url: "http://localhost:4000/invoices/new" })
    Loop->>Browser: browser_snapshot()
    Note over Browser: Injects data-agent-ref into visible inputs.<br/>Maps <label for> to accessible names.
    Browser-->>Loop: Snapshot { elements: [ref 1: Vendor, ref 2: InvNo, ref 3: Amount...] }

    %% 5. Form Interaction & Policy Approval
    Loop->>Browser: browser_select({ ref: 1, value: "Globex Corporation" })
    Loop->>Browser: browser_type({ ref: 2, text: "GLX-2024-0112" })
    Loop->>Browser: browser_type({ ref: 3, text: "4850.00" })
    Loop->>Browser: browser_select({ ref: 4, value: "USD" })
    Loop->>Browser: browser_type({ ref: 5, text: "2024-11-20" })

    %% 6. Mutating Action Policy Gate
    LLM-->>Loop: ToolCall: browser_click({ ref: 6 }) (Submit Button)
    Loop->>Policy: checkPolicyApproval({ tool: "browser_click", ref: 6 })
    Policy->>Browser: Capture form values + screenshot
    Policy->>Server: SSE: approval_required { formValues, screenshot }
    Server-->>User: Display Approval Card (Approve / Reject)
    User->>Server: POST /api/runs/:runId/approve { approved: true }
    Server-->>Policy: Promise Resolved (Approved)
    Policy-->>Loop: { approved: true }
    Loop->>Browser: browser_click({ ref: 6 })
    Browser->>Portal: POST /invoices/new
    Portal-->>Browser: 302 Redirect /invoices/new?success=Invoice+created

    %% 7. Independent Ground-Truth Verification
    LLM-->>Loop: ToolCall: finish({ status: "completed", claimed_outcome })
    Loop->>Verifier: runIndependentVerification({ goal, claimedOutcome })
    Note over Verifier: Fresh execution context.<br/>Zero confirmation bias. Read-only tools only.
    Verifier->>Portal: GET /api/invoices?invoiceNumber=GLX-2024-0112
    Portal-->>Verifier: Invoice { vendor: "Globex Corporation", amount: 4850, dueDate: "2024-11-20" }
    Note over Verifier: 5-Point Field Check:<br/>Existence: Pass<br/>Vendor: Pass<br/>Amount: Pass<br/>Currency: Pass<br/>DueDate: Pass
    Verifier-->>Loop: { verified: true, checks: [5/5 passed] }

    %% 8. Completion & Reporting
    Loop->>Browser: browser_screenshot({ label: "final-verification" })
    Browser-->>Loop: screenshot-final.png
    Loop->>Files: Write sandbox/artifacts/runId/report.md & report.json
    Loop->>DB: Run.findByIdAndUpdate({ status: "completed", durationMs, ... })
    Loop->>Server: SSE: task_finished { status: "completed", summary }
    Server-->>User: Completed Banner + Verification Table + Report Link
```

---

## Detailed Step-by-Step Architectural Walkthrough

### Phase 1: Ingestion & Environment Setup
1. **User Action**: The supervisor provides an instruction via the web dashboard at `http://localhost:3000` or the command-line interface (`npm run cli`).
2. **Server Dispatch**: The Agent Server creates a new `Run` document in MongoDB (`agent_runs` database) with initial status `"running"`, generates a unique run identifier (`run-<timestamp>-<uuid>`), and spawns `runTask`.
3. **Playwright Context**: The runtime opens a persistent, isolated Playwright Chromium browser page configured with viewport dimensions `1280x800`.
4. **Context Discovery**: The runtime inspects `sandbox/context/` to identify available procedure manuals without reading entire file contents into prompt tokens prematurely.

### Phase 2: Autonomous Understanding & Planning
1. **Initial Prompt Construction**: The prompt builder formats:
   - Today's date (ISO format)
   - Available sandbox context files
   - User goal
2. **First Model Turn**: The worker restates the intended business outcome and calls the `update_plan` tool.
3. **Reactive UI Updates**: The runtime intercepts `update_plan`, stores the normalized step objects in `state.plan`, and broadcasts a `plan_updated` SSE event to the dashboard checklist.

### Phase 3: Document Exploration & Date Reasoning
1. **Directory Listing**: The worker calls `list_files({ dir: "sandbox/inbox" })`. The tool enforces strict sandbox confinement, resolving paths relative to `sandbox/` and blocking any traversal attempts (`../../`).
2. **Document Inspection**: The worker reads both Globex files:
   - `sandbox/inbox/globex_resubmission.txt` contains date **September 15, 2024**.
   - `sandbox/inbox/globex_original.txt` contains date **October 20, 2024**.
3. **Document-Internal Reasoning**: Despite the misleading filename `"resubmission"`, the agent analyzes the dates *inside* the invoice bodies and autonomously selects October 20 as the latest invoice.
4. **Fact Retention**: The worker invokes `remember` to persist extracted facts (`invoice_number: "GLX-2024-0112"`, `amount: 4850.00`, `dueDate: "2024-11-20"`) into working memory. These facts are summarized and injected into all subsequent turns.

### Phase 4: Dynamic DOM Discovery & Observation
1. **Portal Navigation**: The worker navigates to `http://localhost:4000/invoices`.
2. **Secure Authentication**: The worker calls `browser_login({ site: "portal" })`. The runtime retrieves `PORTAL_USER` and `PORTAL_PASS` directly from environment configuration, fills the login form, and submits. **The LLM never sees or touches credentials in prompt history.**
3. **DOM Snapshotting**: On `/invoices/new`, the worker calls `browser_snapshot`.
   - The tool clears any existing refs.
   - It identifies all visible interactive candidates (`input`, `select`, `button`, `textarea`, `a[href]`).
   - It injects sequential `data-agent-ref="1"`, `data-agent-ref="2"`, etc.
   - It computes accessible names from associated `<label for="id">` elements, enclosing labels, and ARIA attributes.
   - It returns a concise snapshot JSON containing headings, alerts, and element descriptors.

### Phase 5: Form Interaction & Stale Ref Defense
1. **Ref-Based Typing & Selecting**: The worker fills the form fields using discovered refs:
   - `browser_select({ ref: 1, value: "Globex Corporation" })`
   - `browser_type({ ref: 2, text: "GLX-2024-0112" })`
   - `browser_type({ ref: 3, text: "4850.00" })`
   - `browser_select({ ref: 4, value: "USD" })`
   - `browser_type({ ref: 5, text: "2024-11-20" })`
2. **Stale Ref Guard**: If an element is modified or detached between turns, the tool catches the missing selector and returns a structured `STALE_REF` error with an actionable hint to re-snapshot, preventing silent crashes.

### Phase 6: Code-Enforced Policy Gate (Human Approval)
1. **Mutation Interception**: The worker selects the submit button (`browser_click({ ref: 6 })`).
2. **Code Policy Check**: `checkPolicyApproval` evaluates the element's accessible name (`Create Invoice`) against the mutating regex (`/submit|create|save|delete|update/i`).
3. **Evidence Capture**: The policy layer extracts active form values from the DOM, captures a screenshot (`sandbox/artifacts/<runId>/approval-<timestamp>.png`), and halts the execution loop.
4. **Supervisor Presentation**: The dashboard displays the **Approval Card** with the live screenshot and form values.
5. **Resume on Decision**: When the supervisor clicks **"Approve"**, the promise resolves, allowing the click to proceed. If rejected with a comment, the rejection message is returned to the worker as a tool failure so it can adjust.

### Phase 7: Independent Ground-Truth Verification
1. **Finish Signal**: The worker completes its actions and calls `finish({ status: "completed", claimed_outcome: { ... } })`.
2. **Verifier Invocation**: The runtime intercepts the finish call and initiates `runIndependentVerification`.
3. **Fresh Context Execution**: A fresh execution session is created without the worker's conversational history.
4. **Database Audit**: The verifier issues `http_get({ url: "http://localhost:4000/api/invoices?invoiceNumber=GLX-2024-0112" })` to query the real database record.
5. **5-Point Field Check**:
   - **Existence**: Confirms record exists in MongoDB.
   - **Vendor**: Confirms vendor is `"Globex Corporation"`.
   - **Amount**: Confirms numeric amount is `4850.00`.
   - **Currency**: Confirms currency is `"USD"`.
   - **Due Date**: Confirms payment due date is `"2024-11-20"`.
6. **Discrepancy Loop**: If any check fails, the verification report is fed back to the worker, requiring it to fix discrepancies before completion is granted (up to 2 rounds).

### Phase 8: Artifact Compilation & Reporting
1. **Evidence Screenshot**: The final verified state of the portal is captured via `browser_screenshot`.
2. **Artifact Generation**: The runtime writes:
   - `sandbox/artifacts/<runId>/report.json`: Machine-readable telemetry of every step, plan iteration, duration, and verification check.
   - `sandbox/artifacts/<runId>/report.md`: Formatted human-readable report with Markdown tables and visual links.
3. **Database Finalization**: The MongoDB `Run` record is updated with duration, final status, step count, and verification details.
4. **Dashboard Completion**: The dashboard renders the green **Task Completed** banner and the verification checks table.

---

## Technical Interview Questions & Architecture Answers

### Q1: "Why build your own runtime loop instead of using LangChain or CrewAI?"
> **Answer**:  
> General-purpose agent frameworks introduce heavy abstractions: hidden system prompts, rigid execution chains, automatic function calling that hides errors, and opaque retry logic. In a mission-critical enterprise setting (and in a technical interview), explainability and reliability are paramount. By building a clean manual loop directly on the official `@google/genai` SDK:
> 1. We control prompt token composition and memory injection down to the exact character.
> 2. We implement deterministic safety guards (detecting identical failures 3 times, cutting off 5-error streaks).
> 3. We implement custom context compaction (summarizing historical snapshots) that frameworks do not support out of the box.
> 4. Every single line of code is auditable, explainable, and debuggable in real time.

### Q2: "How does the agent avoid breaking when portal field labels change?"
> **Answer**:  
> Most web scrapers fail under chaos because they rely on brittle CSS selectors like `#invoice-amount` or `input[name='vendorId']`.  
> Our agent uses **accessible DOM snapshots**. When `browser_snapshot` runs, it scans the DOM, maps `<label for="id">` or ARIA tags, and assigns temporary numeric refs (`ref: 1`, `ref: 2`). If a field is renamed from `"Vendor"` to `"Supplier"`, the agent observes the label semantically as a business synonym and interacts via `ref: 1`. Zero CSS selectors exist in the agent code.

### Q3: "How do you prevent the agent from hallucinating that it succeeded?"
> **Answer**:  
> We never trust the worker agent's self-reporting. When the worker calls `finish`, an **Independent Verifier** is automatically invoked with a **fresh context** (zero access to the worker's chat history). The verifier operates strictly with read-only tools (`http_get`, `browser_snapshot`) and queries the company's real REST API and MongoDB database to confirm the record was created with exact field-by-field accuracy. If any field differs, the verifier fails the outcome and forces the worker to adapt.

### Q4: "How do you protect passwords and credentials from leaking into LLM context?"
> **Answer**:  
> Credentials are never placed in the LLM prompt or system instructions. The agent has a dedicated `browser_login` tool. When called, the runtime reads `PORTAL_USER` and `PORTAL_PASS` directly from environment variables in native Node.js code, executes the login form submission, and confirms authentication via session cookie. The agent only receives `{ ok: true, status: "authenticated" }`. Furthermore, all runtime step logs and SSE streams pass through a recursive `redactSecrets` filter that scrubs any field matching `/password|secret|token|key/i`.
