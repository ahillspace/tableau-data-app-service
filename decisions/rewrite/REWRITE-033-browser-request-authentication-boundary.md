# REWRITE-033: Authenticate browser requests without a Tableau Cloud IP restriction

Status: explicitly locked by the user during the mobile review.
Recorded: 2026-11-09.

## Decision

Keep the direct viewer-browser-to-service request path in the accepted frontend/SDK architecture.
Authenticate and authorize those requests using verified identity, scoped service sessions, current app/site/connection authority and revocation checks.
Do not restrict incoming viewer requests to Tableau Cloud server IP addresses as a substitute for those controls.
The viewer browser makes those requests; being embedded in Tableau does not make Tableau Cloud the network caller.
Origin checks remain browser transport controls, not proof of a current Tableau login.

## Boundaries

This does not add a Tableau-hosted proxy or change the frontend/backend execution split.
Network restrictions for fixed server clients or an operator-controlled network remain possible deployment measures, not newly required features or user authentication.
REWRITE-031's service-session policy and REWRITE-032's separate connector reauthorization policy remain distinct.
No numeric session default, renewal evidence mechanism or new provider interval is selected by locking this request boundary.
The existing D01/E01 implementation and Tableau experience evidence gates remain open.

## Verification boundary

This records the agreed architecture boundary, not a live browser request trace or a tested deployment.
