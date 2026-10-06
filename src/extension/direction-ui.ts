import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProjectStatus } from "../core/types.js";

export interface ResearchDirection {
  title: string;
  goal: string;
  nextStep: string;
  rationale: string;
}

const FREE_CHAT = "自由聊天（返回输入框）";
const OTHER = "输入自己的方向";
const REFRESH = "重新生成候选";
const CANCEL = "取消";
export const DIRECTION_FALLBACK_OPTIONS = [FREE_CHAT, OTHER, REFRESH, CANCEL] as const;

export async function showResearchDirections(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  status: ProjectStatus;
  basis: string;
}): Promise<void> {
  if (options.ctx.mode !== "tui" || !options.ctx.hasUI) return;
  if (!options.ctx.model) {
    options.ctx.ui.notify("当前没有可用模型，无法生成研究方向。请先使用 /model 选择模型。", "warning");
    return;
  }
  let basis = options.basis;
  for (let round = 0; round < 3; round += 1) {
    let directions: ResearchDirection[];
    try {
      options.ctx.ui.setStatus("research-directions", "正在生成下一步研究方向…");
      directions = await generateDirections(options.ctx, options.status, basis);
    } catch (error) {
      options.ctx.ui.notify(`生成研究方向失败：${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    } finally {
      options.ctx.ui.setStatus("research-directions", undefined);
    }
    const labels = directions.map((item, index) => formatDirection(index, item));
    const selected = await options.ctx.ui.select("选择下一步研究方向", [...labels, FREE_CHAT, OTHER, REFRESH, CANCEL]);
    if (!selected || selected === CANCEL || selected === FREE_CHAT) return;
    if (selected === REFRESH) {
      basis = `${basis}\n用户要求重新生成差异更明显的候选方向。`;
      continue;
    }
    if (selected === OTHER) {
      const input = (await options.ctx.ui.input("自由输入研究方向", "描述目标或下一步行动"))?.trim();
      if (input) options.pi.sendUserMessage(input, { deliverAs: "followUp" });
      return;
    }
    const index = labels.indexOf(selected);
    const direction = index >= 0 ? directions[index] : undefined;
    if (!direction) return;
    options.pi.sendUserMessage(
      `继续以下研究方向：${direction.title}\n目标：${direction.goal}\n下一步：${direction.nextStep}\n理由：${direction.rationale}\n请先核对当前 Core 状态和必要门禁，再执行或提出需要我确认的动作。`,
      { deliverAs: "followUp" },
    );
    return;
  }
}

async function generateDirections(ctx: ExtensionContext, status: ProjectStatus, basis: string): Promise<ResearchDirection[]> {
  const selectedQuestion = status.questions.find((item) => item.status === "selected")?.question ?? null;
  const systemPrompt = [
    "你是科研路线规划器。基于项目状态和上一轮回答，生成三个彼此不同、具体且可以执行的下一步研究方向。",
    "候选可以是澄清问题、检索证据、形成假设、设计实验或评估风险，但不得声称尚未完成的工作已经完成。",
    "只输出严格 JSON，不要 Markdown：{\"directions\":[{\"title\":\"...\",\"goal\":\"...\",\"nextStep\":\"...\",\"rationale\":\"...\"}]}。",
    "每个字段使用简洁中文；title 不超过 24 字，其他字段不超过 100 字。",
  ].join("\n");
  const prompt = JSON.stringify({
    project: { title: status.project.title, stage: status.project.status, profile: status.project.profile, selectedQuestion },
    latestAnswer: basis.slice(-12_000),
  });
  const response = await ctx.modelRegistry.complete(ctx.model!, {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { signal: ctx.signal });
  if (response.stopReason === "aborted" || response.stopReason === "error") throw new Error(response.errorMessage ?? response.stopReason);
  const text = response.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map(item => item.text).join("\n");
  return parseDirections(text);
}

function parseDirections(raw: string): ResearchDirection[] {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("模型没有返回候选 JSON");
  const parsed = JSON.parse(raw.slice(first, last + 1)) as { directions?: unknown[] };
  if (!Array.isArray(parsed.directions)) throw new Error("候选 JSON 缺少 directions");
  const directions = parsed.directions.slice(0, 4).map((value) => {
    if (!value || typeof value !== "object") throw new Error("候选内容格式错误");
    const item = value as Record<string, unknown>;
    const direction = { title: clean(item.title, 60), goal: clean(item.goal, 240), nextStep: clean(item.nextStep, 240), rationale: clean(item.rationale, 240) };
    if (Object.values(direction).some((part) => part.length === 0)) throw new Error("候选字段不能为空");
    return direction;
  });
  if (directions.length < 2) throw new Error("模型返回的候选不足两个");
  return directions;
}

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function formatDirection(index: number, item: ResearchDirection): string {
  return `${index + 1}. ${item.title}\n目标：${item.goal}\n下一步：${item.nextStep}\n理由：${item.rationale}`;
}

export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.filter((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string").map(item => item.text).join("\n").trim();
}
