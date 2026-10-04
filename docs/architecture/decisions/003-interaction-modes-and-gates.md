# ADR 003: Route every research mutation through Core ResearchAction

- Status: accepted
- Date: 2026-10-04
- Stage: C2

## Context

Research Explorer supports native Pi chat, guided candidates and bounded automation. These entry points must not create separate research state machines or weaken Core gates.

## Decision

The CLI implements three presentation modes over the same Core contracts:

- `manual`: ordinary input continues to Pi. Pi can read bounded Core state and request ResearchAction operations through registered research tools.
- `candidate`: ordinary idle input calls `conversation.send`, then presents Core-issued candidates.
- `auto`: ordinary idle input calls `conversation.send`; Core may execute one action allowed by its persisted policy, otherwise the same candidate UI appears.

Candidate UI always appends `继续用原输入自由聊天`, `输入其他行动` and `取消`. Extension-originated or queued steering/follow-up input is not intercepted.

Every mutation uses `action.execute`, `candidate.choose` or the auto branch of `conversation.send`. The extension does not reproduce transition rules. Write tools require an explicit UI confirmation. `scope.approve` and any action marked `requiresHumanApproval` are refused by the generic action tool and must come from a current Core candidate followed by a separate user confirmation. Core remains the final authority.

The system prompt receives only a bounded status snapshot. Event tools omit event payloads, use pagination and cap pages at 50 records. Tool output is bounded to prevent research history from overwhelming the model context.

## Consequences

- Mode changes alter interaction and persisted Core policy, not research semantics.
- Free chat remains available from candidate mode without consuming the candidate.
- Model-issued direct scope approval cannot acquire a user identity.
- Confirmation, release, Job and plugin lifecycle surfaces are absent from C2 tools and remain unavailable until their dedicated stages.
- Pi session state stores only non-sensitive mode and conversation identifiers; Core owns candidates, policies and action audit.

