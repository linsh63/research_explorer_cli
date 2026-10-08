import assert from "node:assert/strict";
import test from "node:test";
import { alignRunToProjectStatus, approveRunGate, createResearchRun, RESEARCH_RUN_ENTRY, recordRunTurn, restoreResearchRun, runPrompt } from "../src/research/run.js";

test("ResearchRun follows the fixed skeleton and stops at explicit gates", () => {
  let run = createResearchRun({ sessionId: "session-1", projectId: "project-1", goal: "Evaluate a reproducible research hypothesis", maxModelTurns: 20, maxKnownCostUsd: 2 }, new Date("2026-10-06T00:00:00Z"));
  assert.equal(run.stage, "scope");
  assert.match(runPrompt(run), /问题与范围/);
  run = recordRunTurn(run, 0.01);
  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.awaitingGate, "scope_approval");
  run = approveRunGate(run);
  assert.equal(run.status, "running");
  assert.equal(run.stage, "evidence");
  run = recordRunTurn(run, 0.01);
  assert.equal(run.stage, "hypotheses");
  run = recordRunTurn(run, 0.01);
  assert.equal(run.stage, "protocol");
  run = recordRunTurn(run, 0.01);
  assert.equal(run.awaitingGate, "protocol_freeze");
});

test("ResearchRun restores from Pi entries and fails closed at budget", () => {
  const initial = createResearchRun({ sessionId: "session-2", projectId: "project-2", goal: "Bounded goal", maxModelTurns: 1, maxKnownCostUsd: 1 });
  const restored = restoreResearchRun([{ type: "custom", customType: RESEARCH_RUN_ENTRY, data: initial }]);
  assert.equal(restored?.runId, initial.runId);
  const blocked = recordRunTurn(initial, 0);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blocker ?? "", /预算/);
});

test("ResearchRun aligns an existing Core Project without asking Core for a general next action", () => {
  const initial = createResearchRun({ sessionId: "session-3", projectId: "project-3", goal: "Resume existing work" });
  const scoped = alignRunToProjectStatus(initial, "scoped", new Date("2026-10-06T00:00:00Z"));
  assert.equal(scoped.stage, "evidence");
  assert.deepEqual(scoped.completedStages, ["scope"]);
  assert.match(runPrompt(scoped), /唯一来源/);
  assert.match(runPrompt(scoped), /没有可自动推进的行动/);
  assert.equal(alignRunToProjectStatus(initial, "frozen").stage, "baseline");
  assert.equal(alignRunToProjectStatus(initial, "confirmation_observed").stage, "analysis");
  assert.equal(alignRunToProjectStatus(initial, "closed").status, "completed");
});
