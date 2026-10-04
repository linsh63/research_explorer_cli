import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const RESEARCH_EXPLORER_ENTRY = "research-explorer.context";

export interface C0ContextEntry {
  schemaVersion: 1;
  phase: "C0";
  coreStatus: "not_connected";
  recordedAt: string;
}

export default function researchExplorerExtension(pi: ExtensionAPI): void {
  let restored = false;

  pi.registerTool({
    name: "research_c0_echo",
    label: "Research Explorer C0 Echo",
    description: "C0 contract probe. Echoes bounded text without contacting a model or research Core.",
    promptSnippet: "Verify that the Research Explorer extension is loaded",
    promptGuidelines: ["Use research_c0_echo only for Research Explorer C0 integration diagnostics."],
    parameters: Type.Object({ text: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      const text = params.text.slice(0, 200);
      return {
        content: [{ type: "text", text }],
        details: { phase: "C0", bytes: Buffer.byteLength(text) },
      };
    },
  });

  pi.registerEntryRenderer<C0ContextEntry>(RESEARCH_EXPLORER_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(
        `${theme.fg("accent", "[Research Explorer]")} ${data?.phase ?? "C0"} · Core ${data?.coreStatus ?? "not_connected"}`,
        0,
        0,
      ),
    );
    if (expanded && data?.recordedAt) box.addChild(new Text(theme.fg("dim", data.recordedAt), 0, 0));
    return box;
  });

  pi.registerCommand("research-about", {
    description: "Show Research Explorer and persist a non-sensitive C0 context entry",
    handler: async (_args, ctx) => {
      const entry: C0ContextEntry = {
        schemaVersion: 1,
        phase: "C0",
        coreStatus: "not_connected",
        recordedAt: new Date().toISOString(),
      };
      pi.appendEntry(RESEARCH_EXPLORER_ENTRY, entry);
      ctx.ui.notify("Research Explorer C0: Pi extension loaded; Core connection begins in C1.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restored = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === RESEARCH_EXPLORER_ENTRY);
    ctx.ui.setTitle("Research Explorer");
    ctx.ui.setStatus("research-explorer", "C0 · Core not connected");
    ctx.ui.setWidget("research-explorer", [
      "Research Explorer C0",
      "Pi UI/session/tool reuse active",
      "Core connection intentionally deferred to C1",
      restored ? "Context entry restored" : "No saved research context",
    ]);
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (event.text.startsWith("?research ")) {
      return {
        action: "transform" as const,
        text: `Research Explorer C0 diagnostic request: ${event.text.slice(10).trim()}`,
      };
    }
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nResearch Explorer C0 is loaded. The research Core is not connected. Do not claim that research state was read or changed. The research_c0_echo tool is diagnostic only.`,
  }));
  pi.on("turn_start", async (_event, ctx) => ctx.ui.setStatus("research-explorer", "C0 · Pi turn running"));
  pi.on("turn_end", async (_event, ctx) => ctx.ui.setStatus("research-explorer", "C0 · Core not connected"));
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("research-explorer", undefined);
    ctx.ui.setWidget("research-explorer", undefined);
  });
}
