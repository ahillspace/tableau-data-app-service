# Application and specification work

Read docs/product.md before changing a specification.
Local application implementation and task-scoped development dependency setup are authorized; do not publish, deploy, create remotes, or merge into the primary branch.
Keep one shared service deployment with an operator-controlled administrative boundary.
Describe the public product for Data App developers and viewers without restricting its audience to a profession or team.
Exclude personal context, workstation paths and private workflow details from public specification artifacts.
Specs and plans describe our system in original language; external architecture research lives outside this workspace.
Use official protocol/provider documentation to establish external facts.
Write one complete sentence per line in long Markdown and use plain hyphens.
Each component has an owner, narrow interfaces, state invariants, failure/recovery scenarios, and an explicit extension path.
Separate user-stated requirements, architectural recommendations, and unverified assumptions.
Component workers propose changes; the architecture orchestrator owns shared contracts and final integration.
Preserve review history and mark design convergence separately from implementation verification and user acceptance.

Astra owns application design, initial specification authoring, and substantive review.
Reserve GPT-6.1 Sol for implementation and do not use Luna for substantive specification work.

## Current specification authority

Use README.md and specification.json to locate current requirements, contracts and verification gates.
The generated review board embeds these same sources and is not separately maintained policy.
Decisions, reviews and frozen design snapshots preserve historical evidence; they do not override current specifications or supply implementation defaults.
