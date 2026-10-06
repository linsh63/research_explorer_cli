# Core public API gaps for the CLI

Status: tracked external dependencies after C1
Owner repository: `research_explorer_core`

C0 intentionally does not change or push the Core repository. The CLI also does not read Core databases, internal modules or filesystem state as a fallback. Before C1 navigation is considered complete, Core needs stable public contracts and SDK methods for:

| Capability | Required result |
| --- | --- |
| `workspace.projects` | **Resolved in Core 1.6.1:** bounded project summaries with update time and branch/status data |
| `project.pending-actions` | Legal next actions and gates requiring user handling |
| `job.list` | Project filtered and paginated jobs with status and update time |
| `artifact.export` | Policy checked export to a user selected destination without exposing CAS paths |
| Health/readiness | Public TypeScript and Python SDK methods for service and dependency readiness |

Each capability must be added through Core contracts, application/service handlers and public SDKs. Research Explorer should negotiate capabilities and report `capability unavailable` when a deployed Core lacks one. It must not import Core domain, application, storage or migration code.

This register resolves the scope conflict in the original C0 plan: the independent CLI spike is complete, while these Core owned changes remain prerequisites for the affected navigation and later workflows.

C1 consumes the existing authenticated `/v1/health` endpoint directly through the public service protocol, so health is available to `/doctor`. Core 1.6.1 publishes `workspace.projects`; CLI 0.2.0 uses it for the startup and `/project` pickers without a private fallback. A first-class SDK convenience method remains desirable.

C3 tracks the last 100 public Job IDs in non-sensitive CLI state because `job.list` is not published. Artifact status is displayed from `job.get`; direct filesystem export remains unavailable until `artifact.export` exists. These are explicit capability limits rather than private fallbacks.
