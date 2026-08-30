#!/usr/bin/env node
/**
 * index.ts
 *
 * Main entry point for codex-gateway.
 * Bridges the agentrq MCP server with the OpenAI Codex app server.
 */

import { readFileSync } from "node:fs";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

import { loadMcpConfig, pickAgentrqServer } from "./config.js";
import { MCPBridge } from "./mcpClient.js";
import {
  CodexClient,
  type AgentMessageDeltaNotification,
  type ThreadStartParams,
} from "./codexClient.js";
import { extractTaskIdFromMeta, extractTaskIdFromText } from "./taskIdentity.js";
import {
  resolveThreadPolicy,
  ThreadItemRegistry,
  type ItemDescriptor,
} from "./approvals.js";

export function buildTaskPrompt(taskId: string, content: string): string {
  return [
    `[agentrq task_id: ${taskId}]`,
    `You have been assigned an agentrq task. Follow these steps:`,
    `1. Call \`updateTaskStatus\` with taskId="${taskId}" and status="ongoing" before starting work.`,
    `2. Complete the task described below.`,
    `3. When finished, call \`updateTaskStatus\` with taskId="${taskId}" and status="completed".`,
    `Your text output will be automatically relayed as the reply — do not call the \`reply\` tool.`,
    ``,
    content,
  ].join("\n");
}

/** An approval request as it will be presented to the human in agentrq. */
type ApprovalContext = ItemDescriptor & { reason: string };

/**
 * agentrq's own MCP server names, e.g. `agentrq-0cHdAEOUJvN`.
 */
const AGENTRQ_PATTERN = /agentrq-[a-zA-Z0-9]{11}/;

export async function handleTask(
  content: string,
  meta: unknown,
  codexClient: CodexClient,
  mcpBridge: MCPBridge,
  threadMap: Map<string, string>,
  model?: string,
): Promise<void> {
  const chatId = extractTaskIdFromMeta(meta);

  let threadId = chatId ? threadMap.get(chatId) : undefined;
  if (!threadId) {
    const policy = resolveThreadPolicy();
    for (const warning of policy.warnings) {
      console.error(`\n⚠️  [codex] ${warning}`);
    }
    const threadParams: ThreadStartParams = {
      cwd: process.cwd(),
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
    if (model) threadParams.model = model;
    threadId = await codexClient.startThread(threadParams);
    if (chatId) threadMap.set(chatId, threadId);
    console.error(
      `[codex] Created thread ${threadId} for chat ${chatId ?? "unknown"} ` +
        `(approvalPolicy=${policy.approvalPolicy}, sandbox=${policy.sandbox})`,
    );
  } else {
    console.error(`[codex] Reusing thread ${threadId} for chat ${chatId}`);
  }

  const taskContent = chatId ? buildTaskPrompt(chatId, content) : content;

  // Approval requests name their subject only by `itemId`; the command or tool
  // itself was announced earlier in an `item/started` notification. Track those
  // so the human sees what they are actually approving.
  const registry = new ThreadItemRegistry();

  const onItemStarted = (params: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    if (p?.threadId !== threadId) return;
    registry.record(p?.item);
  };

  const onItemCompleted = (params: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    if (p?.threadId !== threadId) return;
    const item = p?.item as Record<string, unknown> | undefined;
    registry.forget(item?.id);
  };

  // Verdicts arrive on a single bridge-wide event. Keep the waiters keyed by
  // request id and tear them all down when the turn ends, so a handler never
  // outlives its turn and every in-flight request still gets an answer.
  const pendingVerdicts = new Map<string, (decision: "allow" | "deny") => void>();

  const onVerdict = (verdict: { requestId: string; behavior: string }) => {
    const resolve = pendingVerdicts.get(verdict.requestId);
    if (!resolve) return;
    pendingVerdicts.delete(verdict.requestId);
    const decision = verdict.behavior === "allow" ? "allow" : "deny";
    console.error(`✅ [codex] Permission verdict: ${verdict.behavior} → ${decision}`);
    resolve(decision);
  };

  /**
   * Describe an approval request, preferring the remembered item over the
   * sparse fields the request itself carries.
   */
  const describeApproval = (
    params: Record<string, unknown> | undefined,
    fallbackTitle: string,
  ): ApprovalContext => {
    const reason = typeof params?.reason === "string" ? params.reason : "";
    const remembered = registry.get(params?.itemId);
    if (remembered) return { ...remembered, reason };

    // The item was never seen (or carried nothing describable) — fall back to
    // whatever is on the request itself.
    const command = typeof params?.command === "string" ? params.command : "";
    return {
      title: command || reason || fallbackTitle,
      inputPreview: command,
      reason,
    };
  };

  /**
   * Auto-allow agentrq's own MCP tool calls, which the gateway itself depends
   * on and which the human already implicitly approved by assigning the task.
   *
   * Deliberately keyed on the MCP server name alone. Matching free text such as
   * a command line or a `reason` would let any command that merely mentions a
   * workspace id approve itself.
   */
  const isAgentrqToolCall = (ctx: ApprovalContext): boolean =>
    ctx.server !== undefined && AGENTRQ_PATTERN.test(ctx.server);

  /** Forward an approval to agentrq and wait for the human's verdict. */
  const routeToHuman = async (
    requestId: string,
    ctx: ApprovalContext,
  ): Promise<"allow" | "deny"> => {
    const decided = new Promise<"allow" | "deny">((resolve) =>
      pendingVerdicts.set(requestId, resolve),
    );

    try {
      await mcpBridge.sendNotification(
        "notifications/claude/channel/permission_request",
        {
          request_id: requestId,
          tool_name: ctx.title,
          description: ctx.reason || ctx.title,
          input_preview: ctx.inputPreview,
        },
      );
    } catch (err) {
      console.error("[codex] Failed to forward permission request:", err);
      pendingVerdicts.delete(requestId);
      return "deny";
    }

    console.error("⌛ [codex] Waiting for human approval in agentrq dashboard...");
    return decided;
  };

  const nextRequestId = (id: number) => `codex-approval-${id}-${Date.now()}`;

  const onCommandApproval = async (data: { id: number; params: unknown }) => {
    const params = data.params as Record<string, unknown> | undefined;
    const ctx = describeApproval(params, "Command execution");

    if (isAgentrqToolCall(ctx)) {
      console.error(`\n🔓 [codex] Auto-allowing agentrq tool: ${ctx.title}`);
      codexClient._sendResponse(data.id, { decision: "acceptForSession" });
      return;
    }

    console.error(`\n🔐 [codex] Approval requested (command): ${ctx.title}`);
    const decision = await routeToHuman(nextRequestId(data.id), ctx);
    codexClient._sendResponse(data.id, {
      decision: decision === "allow" ? "accept" : "decline",
    });
  };

  const onFileChangeApproval = async (data: { id: number; params: unknown }) => {
    const params = data.params as Record<string, unknown> | undefined;
    const ctx = describeApproval(params, "File change");

    console.error(`\n🔐 [codex] Approval requested (file change): ${ctx.title}`);
    const decision = await routeToHuman(nextRequestId(data.id), ctx);
    codexClient._sendResponse(data.id, {
      decision: decision === "allow" ? "accept" : "decline",
    });
  };

  const onPermissionsApproval = async (data: { id: number; params: unknown }) => {
    const params = data.params as Record<string, unknown> | undefined;
    const requested = params?.permissions;
    const ctx = describeApproval(params, "Additional permissions");
    if (!registry.get(params?.itemId)) {
      ctx.inputPreview = JSON.stringify(requested ?? {});
    }

    console.error(`\n🔐 [codex] Approval requested (permissions): ${ctx.title}`);
    const decision = await routeToHuman(nextRequestId(data.id), ctx);
    // GrantedPermissionProfile mirrors the requested profile, and has no
    // required fields — granting nothing denies the escalation while leaving
    // the turn free to continue inside its existing sandbox.
    codexClient._sendResponse(data.id, {
      permissions: decision === "allow" ? (requested ?? {}) : {},
      scope: "turn",
    });
  };

  let replyText = "";
  const onDelta = (params: AgentMessageDeltaNotification) => {
    if (params.threadId === threadId) {
      replyText += params.delta;
      process.stdout.write(params.delta);
    }
  };

  mcpBridge.on("verdict", onVerdict);
  codexClient.on("notification:item/started", onItemStarted);
  codexClient.on("notification:item/completed", onItemCompleted);
  codexClient.on("server-request:item/commandExecution/requestApproval", onCommandApproval);
  codexClient.on("server-request:item/fileChange/requestApproval", onFileChangeApproval);
  codexClient.on("server-request:item/permissions/requestApproval", onPermissionsApproval);
  codexClient.on("notification:item/agentMessage/delta", onDelta);

  try {
    const turnId = await codexClient.startTurn(threadId, taskContent, model);
    console.error(`[codex] Turn ${turnId} started in thread ${threadId}`);
    await codexClient.waitForTurnCompletion(threadId, turnId);
    console.error(`[codex] Turn ${turnId} completed`);
  } catch (err) {
    console.error("[codex] Turn error:", err);
  } finally {
    mcpBridge.off("verdict", onVerdict);
    codexClient.off("notification:item/started", onItemStarted);
    codexClient.off("notification:item/completed", onItemCompleted);
    codexClient.off("server-request:item/commandExecution/requestApproval", onCommandApproval);
    codexClient.off("server-request:item/fileChange/requestApproval", onFileChangeApproval);
    codexClient.off("server-request:item/permissions/requestApproval", onPermissionsApproval);
    codexClient.off("notification:item/agentMessage/delta", onDelta);

    // The turn is over; anything still waiting on a human will never be
    // answered, so deny it rather than leaving codex blocked on a response.
    for (const resolve of pendingVerdicts.values()) resolve("deny");
    pendingVerdicts.clear();
    registry.clear();
  }

  if (replyText.trim() && chatId) {
    try {
      await mcpBridge.callTool("reply", { chatId, text: replyText });
      console.error(`[codex] Reply sent to chat ${chatId}`);
    } catch (err) {
      console.error("[codex] Failed to send reply:", err);
    }
  } else if (!replyText.trim()) {
    console.error("[codex] No reply text to send");
  }
}

export async function checkForNextTask(
  mcpBridge: MCPBridge,
  codexClient: CodexClient,
  threadMap: Map<string, string>,
  model?: string,
): Promise<void> {
  console.error("[bridge] Checking for next task via MCP server...");
  try {
    // getTask with no taskId dequeues the next "not started" task assigned to
    // this agent (formerly the getNextTask tool, merged in agentrq v0.3.6).
    const result = await mcpBridge.callTool("getTask");

    if (result.isError) {
      console.error("[mcp] Error getting next task:", result.content);
      return;
    }

    const contentBlock = result.content as Array<{
      type: string;
      text?: string;
    }>;
    const first = contentBlock[0] as { type: string; text: string } | undefined;

    if (first?.text && !first.text.includes("no pending tasks exist")) {
      const text = first.text;
      console.error(
        `[bridge] Found task: "${text.slice(0, 50).replace(/\n/g, " ")}..."`,
      );

      const taskId = extractTaskIdFromText(text);
      const meta = taskId ? { chat_id: taskId } : undefined;

      await handleTask(text, meta, codexClient, mcpBridge, threadMap, model);

      // Recursively check for next task
      await checkForNextTask(mcpBridge, codexClient, threadMap, model);
    } else {
      console.error("[bridge] No pending tasks available.");
    }
  } catch (err) {
    console.error("[bridge] Failed to check for next task:", err);
  }
}

async function main() {
  console.log(`Starting [codex-gateway] ${pkg.name} v${pkg.version}`);

  const args = process.argv.slice(2);
  const cmdStartIndex = args.indexOf("--");
  const codexArgs = cmdStartIndex !== -1 ? args.slice(cmdStartIndex + 1) : [];

  const [codexCmd, ...codexCmdArgs] =
    codexArgs.length > 0 ? codexArgs : ["codex", "app-server"];

  // Load MCP config and connect to agentrq
  const configs = loadMcpConfig();
  const agentrqConfig = pickAgentrqServer(configs);
  const mcpBridge = new MCPBridge(agentrqConfig);
  await mcpBridge.connect();

  // Start codex app-server
  console.error(`[codex] Spawning: ${codexCmd} ${codexCmdArgs.join(" ")}`);
  const codexClient = new CodexClient(codexCmd, codexCmdArgs);
  await codexClient.start();

  const model = process.env.CODEX_MODEL;
  const threadMap = new Map<string, string>(); // chatId → threadId

  // Bridge: MCP → Codex
  mcpBridge.on("task", async ({ content, meta }) => {
    console.error(
      "\n[bridge] Incoming task from MCP server. Forwarding to Codex...",
    );
    try {
      await handleTask(content, meta, codexClient, mcpBridge, threadMap, model);
    } catch (err) {
      console.error("[bridge] Error handling task:", err);
    }
  });

  // Initial check for pending tasks
  await checkForNextTask(mcpBridge, codexClient, threadMap, model);

  // Keep the process alive
  await new Promise(() => {});
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}
