# Heuristic Learning Implementation

## Phase 1: ACP/HRC Capture Foundation

Status: Complete

Capture records are persisted with ACP/HRC identifiers needed for later replay and audit.

## Phase 2: Deterministic Workflow Replay

Status: Complete

Replay tooling can reconstruct workflow runs from recorded captures and deterministic inputs.

## Phase 3: Low-Authority Learning Workflows

Status: Complete

Low-authority learning workflows operate on captured evidence without mutating promoted runtime behavior.

## Phase 4: High-Authority Proposal and Replay Workflows

Status: Complete

High-authority proposal flows emit auditable proposals and replay artifacts before promotion.

## Phase 5: Promotion, Rollback, and Audit Workflows

Status: Complete

Promotion and rollback paths preserve audit records that connect decisions to the originating replay evidence.

## Phase 6: Learning-Workflow Self-Improvement Governance

Status: Complete

Governance checks keep learning workflow changes reviewable before they affect production behavior.

## wlearn Tooling

Status: Complete

`wlearn` provides downstream inspection and replay helpers for captured workflow learning data.

Manual smoke: replay and inspection commands were exercised against the local ACP/HRC development stack.

