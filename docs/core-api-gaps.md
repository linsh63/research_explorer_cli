# Core public API gaps for the CLI

Status: tracked external dependencies after C0  
Owner repository: `auto-research-agent`

C0 intentionally does not change or push the Core repository. The CLI also does not read Core databases, internal modules or filesystem state as a fallback. Before C1 navigation is considered complete, Core needs stable public contracts and SDK methods for:

| Capability | Required result |
| --- | --- |
| `workspace.projects` | Paginated project summaries with update time and pending state |
| `project.pending-actions` | Legal next actions and gates requiring user handling |
| `job.list` | Project filtered and paginated jobs with status and update time |
| `artifact.export` | Policy checked export to a user selected destination without exposing CAS paths |
| Health/readiness | Public TypeScript and Python SDK methods for service and dependency readiness |

Each capability must be added through Core contracts, application/service handlers and public SDKs. Research Explorer should negotiate capabilities and report `capability unavailable` when a deployed Core lacks one. It must not import Core domain, application, storage or migration code.

This register resolves the scope conflict in the original C0 plan: the independent CLI spike is complete, while these Core owned changes remain prerequisites for the affected C1 and later workflows.

