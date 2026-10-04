import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeError } from "../core/client.js";
import { SshRuntime } from "../research/ssh.js";

export interface SshCommandHost { runtime(ctx: ExtensionContext): Promise<SshRuntime | null> }

export function registerSshCommands(pi: ExtensionAPI, host: SshCommandHost): void {
  pi.registerCommand("research-ssh-setup", {
    description: "Configure, verify, install and attach a Linux SSH Worker",
    handler: async (args, ctx) => {
      const runtime = await host.runtime(ctx);
      if (!runtime) return;
      const hostAlias = args.trim() || (await ctx.ui.input("SSH Host alias", "Alias from ~/.ssh/config"))?.trim();
      if (!hostAlias) return;
      const name = (await ctx.ui.input("Profile name", hostAlias))?.trim() || hostAlias;
      const remoteRoot = (await ctx.ui.input("Remote root", "/tmp/research-worker"))?.trim() || "/tmp/research-worker";
      const expectedArch = (await ctx.ui.input("Expected architecture (optional)", "x64 or arm64"))?.trim() || null;
      const sshConfigFile = (await ctx.ui.input("SSH config file (optional)", "Use system default when empty"))?.trim() || null;
      try {
        const profile = await runtime.addProfile({ name, hostAlias, remoteRoot, expectedArch, sshConfigFile });
        const initial = await runtime.probe(profile.id);
        const approved = await ctx.ui.confirm(
          "Verify SSH host fingerprint",
          `${initial.fingerprint}\n\nVerify this fingerprint through a trusted channel. Approval permits key-based BatchMode SSH; passwords and private keys are never collected.`,
        );
        if (!approved) { ctx.ui.notify(`Profile ${profile.id} remains pending.`, "warning"); return; }
        await runtime.approve(profile.id, initial.fingerprint);
        const trusted = await runtime.probe(profile.id);
        if (!trusted.trusted || trusted.remotePlatform?.os !== "linux") throw new Error(`Trusted Linux preflight failed: ${trusted.issues.join(", ")}`);
        if (!(await ctx.ui.confirm("Install remote Worker?", `${trusted.remotePlatform.arch} · Node ${trusted.remotePlatform.nodeVersion ?? "unknown"}\nRemote root: ${remoteRoot}`))) return;
        const installed = await runtime.install(profile.id);
        const enabled = await runtime.enable(installed.id);
        await runtime.attach(profile.id, enabled.id);
        ctx.ui.notify(`SSH Worker attached: ${profile.id} · ${enabled.id}`, "info");
      } catch (error) {
        ctx.ui.notify(`SSH Worker setup failed: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("research-ssh-status", {
    description: "Show SSH profiles, installations and active Project requirements",
    handler: async (_args, ctx) => {
      const runtime = await host.runtime(ctx);
      if (!runtime) return;
      try {
        const [workspace, project] = await Promise.all([runtime.profiles(), runtime.project()]);
        const profiles = workspace.profiles.map((item) => `${item.id} · ${item.hostAlias} · ${item.status}`).join("\n") || "No SSH profiles";
        const installations = workspace.installations.map((item) => `${item.id} · ${item.status} · ${item.contentHash.slice(0, 12)}…`).join("\n") || "No Worker installations";
        ctx.ui.notify(`Profiles:\n${profiles}\nWorkers:\n${installations}\nProject requirements: ${project.requirements.length}`.slice(0, 4000), "info");
      } catch (error) { ctx.ui.notify(`SSH status failed: ${safeError(error)}`, "error"); }
    },
  });
}
