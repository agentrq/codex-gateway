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
    const sandbox = (process.env.CODEX_SANDBOX ?? "read-only") as ThreadStartParams["sandbox"];
    const threadParams: ThreadStartParams = {
      cwd: process.cwd(),
      sandbox,
    };
    if (model) threadParams.model = model;
    threadId = await codexClient.startThread(threadParams);
    if (chatId) threadMap.set(chatId, threadId);
    console.error(
      `[codex] Created thread ${threadId} for chat ${chatId ?? "unknown"}`,
    );
  } else {
    console.error(`[codex] Reusing thread ${threadId} for chat ${chatId}`);
  }

  const taskContent = chatId ? buildTaskPrompt(chatId, content) : content;

  const AGENTRQ_PATTERN = /agentrq-[a-zA-Z0-9]{11}/;

  const onApprovalRequest = async (data: { id: number; params: unknown }) => {
    const params = data.params as Record<string, unknown> | undefined;
    const reason = typeof params?.reason === "string" ? params.reason : "Unknown command";
    const command = typeof params?.command === "string" ? params.command : "";
    const toolTitle = typeof params?.tool_title === "string" ? params.tool_title : "";
    const connectorId = typeof params?.connector_id === "string" ? params.connector_id : "";

    // Auto-allow agentrq MCP tool calls (same pattern as acp-gateway)
    const isAgentrqTool = AGENTRQ_PATTERN.test(toolTitle) || AGENTRQ_PATTERN.test(connectorId) || AGENTRQ_PATTERN.test(reason);
    if (isAgentrqTool) {
      console.error(`\n🔓 [codex] Auto-allowing agentrq tool: ${toolTitle || reason}`);
      codexClient._sendResponse(data.id, { decision: "acceptForSession" });
      return;
    }

    const requestId = `codex-approval-${data.id}-${Date.now()}`;

    console.error(`\n🔐 [codex] Approval requested: ${reason}`);

    try {
      await mcpBridge.sendNotification("notifications/claude/channel/permission_request", {
        request_id: requestId,
        tool_name: command || reason,
        description: reason,
        input_preview: command,
      });
    } catch (err) {
      console.error("[codex] Failed to forward permission request:", err);
      codexClient._sendResponse(data.id, { decision: "decline" });
      return;
    }

    console.error("⌛ [codex] Waiting for human approval in agentrq dashboard...");

    const handler = (verdict: { requestId: string; behavior: string }) => {
      if (verdict.requestId === requestId) {
        mcpBridge.off("verdict", handler);
        const decision = verdict.behavior === "allow" ? "accept" : "decline";
        console.error(`✅ [codex] Permission verdict: ${verdict.behavior} → ${decision}`);
        codexClient._sendResponse(data.id, { decision });
      }
    };
    mcpBridge.on("verdict", handler);
  };

  let replyText = "";
  const onDelta = (params: AgentMessageDeltaNotification) => {
    if (params.threadId === threadId) {
      replyText += params.delta;
      process.stdout.write(params.delta);
    }
  };

  codexClient.on("server-request:item/commandExecution/requestApproval", onApprovalRequest);
  codexClient.on("notification:item/agentMessage/delta", onDelta);

  try {
    const turnId = await codexClient.startTurn(threadId, taskContent, model);
    console.error(`[codex] Turn ${turnId} started in thread ${threadId}`);
    await codexClient.waitForTurnCompletion(threadId, turnId);
    console.error(`[codex] Turn ${turnId} completed`);
  } catch (err) {
    console.error("[codex] Turn error:", err);
  } finally {
    codexClient.off("server-request:item/commandExecution/requestApproval", onApprovalRequest);
    codexClient.off("notification:item/agentMessage/delta", onDelta);
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
    const result = await mcpBridge.callTool("getNextTask");

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
