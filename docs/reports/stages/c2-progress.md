# C2 completion report

- Status: passed on Linux; macOS CI gate configured
- Completed: 2026-10-04
- Product version: `0.1.0-alpha.2`

## Delivered

- Manual, candidate and bounded auto modes backed by Core `ExecutionPolicy`.
- `/research-mode manual|candidate|auto` and `/research-next`.
- Five bounded tools: `research_context`, `research_events`, `research_converse`, `research_choose_candidate` and `research_execute_action`.
- Candidate UI with fixed free-chat, other-input and cancel choices.
- Explicit confirmations for writes and a dedicated mandatory-scope approval prompt.
- Bounded, refreshed Project snapshot in `before_agent_start`.
- Mode and Core conversation session recovery through Pi entries and recent state.

## Acceptance evidence

`npm run validate:c2` uses real Core and Pi RPC without a model call. It creates equivalent Projects and verifies:

1. direct action, candidate selection and auto conversation all emit `question.proposed` with the same semantic ResearchAction;
2. every Core candidate set ends with free input;
3. candidate UI exposes free chat, other input and cancel;
4. auto stops at scope approval;
5. agent direct scope approval is rejected with `GATE_REJECTED`;
6. explicit user candidate approval reaches `scoped`;
7. Pi persists and restores auto mode and conversation ID without persisting the Core token.

The machine-readable result is [`../validation/c2-validation.json`](../validation/c2-validation.json). Unit tests cover routing, fixed choices, native manual chat, explicit write confirmation, mandatory gate refusal, candidate approval cancellation and degraded restoration.

The workflow [`.github/workflows/c2.yml`](../../../.github/workflows/c2.yml) runs C0, C1 and the same real-Core C2 acceptance on Ubuntu 24.04 and macOS 14.

## Result

C2 provides the first useful research interaction loop while retaining Pi's normal chat. Research Explorer can guide or automatically execute early question transitions, but Core continues to enforce every state change and mandatory gate. Jobs, event streaming, artifacts and SSH Worker interaction remain C3 scope.

