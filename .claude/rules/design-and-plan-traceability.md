# Design and plan traceability

- Two sources define what to build: the technical plan and the UI design artifact (https://claude.ai/artifact/Ge1aEALd5zZvNEGPQZmC5u). Every web or UI issue links its design page and its plan section under References, with the acceptance criteria.
- Before building, open the live artifact and compare it with the issue. The exported images under `docs/design/` may be stale; the artifact wins. Record any difference in an issue comment before you code, and update the issue.
- If the artifact and the plan disagree, stop and ask the owner; do not pick one.
- The PR body links the design page and plan section, and states what in the build differs from the design (or "Matches design").
- A UI element with no design page and no issue is not built. Open an issue for the design gap instead.
