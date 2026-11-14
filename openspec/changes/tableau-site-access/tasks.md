# Site access implementation tasks

Status: future implementation only; no checked task or runtime result is implied by this design update.
Use the shared Access/Persistence/HTTP foundation and [V02](../../../verification.md#v02---registry-and-personalshared-authority).

## 1. Registry and identity

- [ ] 1.1 Add stable configured deployment/site identity, unique registry state and atomic safe attribution through the single migration owner.
- [ ] 1.2 Implement validated registration/keyset listing/enable/disable with no arbitrary discovery fetch, identity mutation or implicit disabled-entry re-enable.
- [ ] 1.3 Verify both Cloud/Server adapter mappings and controlled URL alias continuity, distinguishing site names/browser input from verified stable IDs.

## 2. Protected existing interface

- [ ] 2.1 Implement registry-only credential verification and the three canonical routes, rejecting viewer/provider credentials and spoofed actor/email authority.
- [ ] 2.2 Verify the existing trusted enrollment-client journey using deployment/site input, with no new UI, backend consumer grant or site-approval gate.
- [ ] 2.3 Test concurrent registration, failure-to-commit, malformed routing input, immutable identity and atomic attribution without secrets in output/logs.

## 3. Current authority and proof

- [ ] 3.1 Integrate current enabled-site checks with session establish/restore and coherent ordinary native/capability snapshots; retain ordered locks for mutations, background starts/checkouts and final saved-result disclosure.
- [ ] 3.2 Race disablement and absent shared-audience insert/delete against snapshot reads and transactional use, proving the distinct overlap boundaries; new sites inherit no shared account and personal resources remain owner-isolated across configured apps.
- [ ] 3.3 Preserve already-started eligible outcomes and retained history after disable/disconnect while denying later unauthorized provider work.
- [ ] 3.4 Run actual approved/unapproved-site journeys on Cloud and Server plus real Postgres races; record separate session-restoration gaps and archive only after implementation/review evidence.
