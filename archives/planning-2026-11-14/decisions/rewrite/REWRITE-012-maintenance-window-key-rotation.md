# REWRITE-012: Encrypt credentials and rotate keys during maintenance

Status: accepted by the user for the architecture rewrite.
Recorded: 2026-11-08.
Audit topic: D11.

## Decision

Require authenticated encryption for stored provider credentials using an established library.
Bind encrypted material to its intended connection context.
Allow planned maintenance downtime for encryption-key replacement to reduce operational complexity.
Do not require transparent online rotation, concurrent re-encryption during ordinary traffic, or a general key-management subsystem.
Choose protected key storage appropriate to the selected hosting environment.
Document and test a concrete key-replacement and interruption-recovery procedure before describing rotation as supported.

## Rationale

The user explicitly accepts a maintenance window when it reduces failure points.
Credential protection remains necessary, but continuous availability during key rotation is not an accepted requirement.
A bounded operational procedure is preferable to an elaborate live migration mechanism for this internal service.

## Required rewrite consequences

Specify how maintenance prevents all concurrent credential use and mutation across API processes, workers, callbacks, refresh attempts, and credential-writing ingress.
Account for already dispatched provider requests before beginning re-encryption.
Define how interruption is detected and how operators safely resume or restore without losing required key material.
Do not assume downtime makes a partially completed migration atomic or removes the need to identify the correct decrypting key.
Keep any temporary old/new key handling limited to the chosen procedure rather than promising an online rotation platform.
Verify encrypted data before reopening traffic and retain required keys until the backup and recovery policy permits removal.
Avoid logging or copying plaintext credentials into migration artifacts.

## Details still to resolve

The architecture owner must select the smallest workable migration procedure, encryption envelope, key identifiers if needed, key custody, and operational ownership.
Define the exact encrypted data covered and reconcile backups with rotation and recovery.
No cryptographic algorithm, hosting key store, maintenance duration, or migration tool has been selected.
This decision does not accept the separate database-restore policy under X01.

## Affected specification areas

Update specs/access-connections.md, specs/persistence-operations.md, specs/contracts.md, architecture.md, decisions/choices.md, and verification.md.
Remove online-rotation assumptions and unnecessary live-update coordination while retaining credential confidentiality and integrity requirements.

## Acceptance evidence for the rewrite

Describe a successful maintenance rotation, interruption partway through, missing or incorrect keys, and backup recovery involving an older key.
Show all credential users are stopped or safely excluded before mutation and that checks precede reopening.
Do not claim the procedure is supported until a representative interruption and recovery drill succeeds.

## Verification boundary

This records accepted availability and complexity tradeoffs, not implemented encryption, key custody, or tested rotation.
