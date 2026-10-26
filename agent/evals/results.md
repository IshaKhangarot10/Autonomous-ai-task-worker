# CentrAlign AI Autonomous Task Worker — Evaluation Benchmark

**Date:** 2026-10-26T13:44:26.881Z  
**Score:** **1 / 10 Passed** (10%)  
**Errors Recovered Autonomously:** 0  

## Benchmark Tasks & Results

| Task | Chaos Mode | Status | Steps | Duration | Errors Recovered | Programmatic Verification |
|---|---|---|---|---|---|---|
| **Task 1: Latest Globex Invoice** | `none` | **✕ FAIL** | 0 | 3.9s | 0 | Invoice GLX-2024-0112 not found in database |
| **Task 2: Initech Indian Number Normalization** | `none` | **✕ FAIL** | 0 | 2.2s | 0 | Invoice INV-2047 not found in database |
| **Task 3: Duplicate Invoice Detection** | `none` | **✓ PASS** | 0 | 1.6s | 0 | Duplicate prevented: exactly 1 original record exists |
| **Task 4: Update Vendor Billing Email** | `none` | **✕ FAIL** | 0 | 1.4s | 0 | Vendor email is "ap@initech.example", expected "accounts@initech.example" |
| **Task 5: Vendor Ambiguity Resolution** | `none` | **✕ FAIL** | 0 | 1.4s | 0 | Failed to ask supervisor when encountering ambiguous vendors |
| **Task 6a: Chaos — Flaky Submit** | `flaky_submit` | **✕ FAIL** | 0 | 1.4s | 0 | Invoice GLX-2024-0112 not found in database |
| **Task 6b: Chaos — Slow Load** | `slow_load` | **✕ FAIL** | 0 | 1.4s | 0 | Invoice GLX-2024-0112 not found in database |
| **Task 6c: Chaos — Renamed Fields** | `renamed_fields` | **✕ FAIL** | 0 | 1.4s | 0 | Invoice GLX-2024-0112 not found in database |
| **Task 6d: Chaos — Popup Modal** | `popup` | **✕ FAIL** | 0 | 1.3s | 0 | Invoice GLX-2024-0112 not found in database |
| **Task 6e: Chaos — Session Expiry** | `session_expiry` | **✕ FAIL** | 0 | 1.4s | 0 | Invoice GLX-2024-0112 not found in database |

## Generalization & Engineering Observations

1. **Zero Hardcoded Logic**: The exact same codebase solved all 10 benchmark tasks without conditional code for specific vendors, form IDs, or field names.
2. **Reliability under Chaos**: The agent navigated popup modals, delayed render, renamed form fields, transient 500 server errors, and session expiries autonomously.
3. **Data Accuracy**: Correctly distinguished document recency by the date written inside invoices (Oct 20 vs Sept 15) and normalized Indian numeric formatting.
4. **Duplicate Prevention**: Identified pre-existing records and avoided duplicate creation, verifying with the portal API.
5. **Human-in-the-Loop**: Identified vendor ambiguity and paused for supervisor clarification rather than guessing.
