# Specification work

Read GOALS.md before changing a specification.
This workspace is a design exercise; do not implement the application, install a platform, or publish/deploy anything.
Keep one shared internal service for a solutions engineering team as the operating scope.
Specs and plans describe our system in original language; external architecture research lives outside this workspace.
Use official protocol/provider documentation to establish external facts.
Write one complete sentence per line in long Markdown and use plain hyphens.
Each component has an owner, narrow interfaces, state invariants, failure/recovery scenarios, and an explicit extension path.
Separate user-stated requirements, architectural recommendations, and unverified assumptions.
Component workers propose changes; the architecture orchestrator owns shared contracts and final integration.
Preserve review history and mark design convergence separately from implementation verification and user acceptance.

Astra owns application design, initial specification authoring, and substantive review.
Reserve GPT-6.1 Sol for implementation and do not use Luna for substantive specification work.
