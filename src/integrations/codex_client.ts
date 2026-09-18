import { spawn } from "node:child_process";

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export type ExecError = Error & {
  stdout?: string;
  stderr?: string;
};

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export function diagnoseCodexFailure(err: ExecError): string {
  const msg = `${err?.message ?? ""}\n${err?.stderr ?? ""}`.toLowerCase();
  if (msg.includes("enoent") || msg.includes("spawn codex")) {
    return "Codex CLI not found. Make sure `codex` is installed and on PATH.";
  }
  if (
    msg.includes("login") ||
    msg.includes("not logged in") ||
    msg.includes("auth")
  ) {
    return "Codex CLI authentication required. Run `codex login` and try again.";
  }
  if (msg.includes("timed out")) {
    return "Codex timed out. Shorten the request or increase the timeout.";
  }
  return "Codex execution failed. Check server stderr for details.";
}

export async function runCodexExec({
  prompt,
  cwd,
  timeoutMs = 180000,
  webSearch,
  sandbox,
  approvalPolicy,
  ephemeral = false,
  ignoreUserConfig = false,
}: {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  webSearch?: boolean;
  sandbox?: SandboxMode;
  approvalPolicy?: "never" | "on-request" | "untrusted";
  ephemeral?: boolean;
  ignoreUserConfig?: boolean;
}): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const args = ["exec", "--skip-git-repo-check"];
    const envWebSearch = process.env.CODEX_WEB_SEARCH;
    const webSearchEnabled =
      webSearch ?? (envWebSearch !== "0" && envWebSearch !== "false");
    if (!webSearchEnabled) {
      args.push("-c", 'web_search="disabled"');
      args.push("-c", "features.web_search_request=false");
    }
    if (sandbox) {
      args.push("--sandbox", sandbox);
    }
    if (approvalPolicy) {
      args.push("-c", `approval_policy="${approvalPolicy}"`);
    }
    if (ephemeral) {
      args.push("--ephemeral");
    }
    if (ignoreUserConfig) {
      args.push("--ignore-user-config");
    }
    if (process.env.CODEX_MODEL) {
      args.push("-c", `model="${process.env.CODEX_MODEL}"`);
    }
    if (process.env.CODEX_REASONING_EFFORT) {
      args.push("-c", `reasoning.effort="${process.env.CODEX_REASONING_EFFORT}"`);
    }
    args.push(prompt);
    const child = spawn(process.env.CODEX_BIN || "codex", args, {
      cwd,
      env: {
        ...process.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf-8")));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const e: ExecError = new Error(
          `Codex command failed with exit code: ${code}`
        );
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
