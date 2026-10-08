import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeError } from "../core/client.js";
import type { ResearchRuntime } from "../research/runtime.js";
import type { ConversationOutcome, ResearchCandidate } from "../research/types.js";

const FREE_CHAT = "继续用原输入自由聊天";

export async function runCandidateInteraction(options: {
  runtime: ResearchRuntime;
  message: string;
  sessionId: string | null;
  ctx: ExtensionContext;
  onOutcome(outcome: ConversationOutcome): Promise<void>;
}): Promise<"handled" | "continue"> {
  let outcome: ConversationOutcome;
  try {
    outcome = await options.runtime.converse(options.message, options.sessionId, "user");
    await options.onOutcome(outcome);
  } catch (error) {
    options.ctx.ui.notify(`Core conversation failed: ${safeError(error)}`, "error");
    return "continue";
  }

  for (let round = 0; round < 5; round += 1) {
    if (outcome.executedAction) {
      options.ctx.ui.notify(`Core executed: ${outcome.executedAction.title}`, "info");
      return "handled";
    }
    const set = outcome.candidates;
    if (!set) {
      options.ctx.ui.notify(outcome.reply, "info");
      return "handled";
    }
    const actions = set.candidates.filter((candidate): candidate is ResearchCandidate & { action: NonNullable<ResearchCandidate["action"]> } => candidate.kind === "action" && candidate.action !== null);
    const labels = actions.map((candidate, index) => `${index + 1}. ${candidate.title}${candidate.action.requiresHumanApproval ? " [需要人工批准]" : ""}`);
    const choice = await options.ctx.ui.select(outcome.reply, [...labels, FREE_CHAT]);
    if (!choice) return "handled";
    if (choice === FREE_CHAT) return "continue";
    try {
      const index = labels.indexOf(choice);
      const candidate = index >= 0 ? actions[index] : undefined;
      if (!candidate) {
        options.ctx.ui.notify("Candidate selection is no longer valid.", "error");
        return "handled";
      }
      if (candidate.action.requiresHumanApproval || candidate.action.type === "scope.approve") {
        const approved = await options.ctx.ui.confirm(
          "批准科研范围？",
          `${candidate.title}\n\n${candidate.description}\n\n这会在 Core 中记录不可自动跨越的人工批准。`,
        );
        if (!approved) return "handled";
      }
      outcome = await options.runtime.chooseCandidate({ sessionId: outcome.sessionId, candidateSetId: set.id, candidateId: candidate.id }, "user");
      await options.onOutcome(outcome);
    } catch (error) {
      options.ctx.ui.notify(`Candidate action failed: ${safeError(error)}`, "error");
      return "handled";
    }
  }
  options.ctx.ui.notify("Candidate interaction reached its bounded selection limit.", "warning");
  return "handled";
}

export const CANDIDATE_FALLBACK_OPTIONS = [FREE_CHAT] as const;
