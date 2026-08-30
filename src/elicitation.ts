/**
 * elicitation.ts
 *
 * Bridges codex's `mcpServer/elicitation/request` to agentrq's `elicit` MCP
 * tool, so a question an MCP server asks during a turn reaches the human in the
 * dashboard instead of going unanswered.
 *
 * The two protocols line up closely: codex sends
 * `{serverName, threadId, turnId, mode, message, ...}` and expects
 * `{action: "accept" | "decline" | "cancel", content?}` back, which is the same
 * three-action model agentrq's `elicit` tool returns.
 */

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationResponse {
  action: ElicitationAction;
  content?: Record<string, unknown>;
}

/** The slice of MCPBridge this module needs, kept narrow for testing. */
export interface ElicitationBridge {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ElicitationDeps {
  mcpBridge: ElicitationBridge;
  /** Map a codex threadId back to the agentrq task that thread is running. */
  resolveTaskId(threadId: unknown): string | undefined;
}

function firstText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : undefined;
}

/**
 * Create a task for an elicitation that has no thread to attach to, and mark it
 * ongoing. `elicit` requires a task id, so without this such a question could
 * only be cancelled. Returns the new task's id, or undefined if creation failed.
 */
async function createTaskForElicitation(
  mcpBridge: ElicitationBridge,
  message: string,
): Promise<string | undefined> {
  const title = message.length > 80 ? `${message.slice(0, 77)}...` : message;
  try {
    const created = await mcpBridge.callTool("createTask", {
      title: title || "Codex needs an answer",
      body: message,
      assignee: "human",
    });
    const text = firstText(created);
    const taskId = text?.match(/id=(\S+)/)?.[1];
    if (!taskId) {
      console.error(
        `[codex] Could not parse task ID from createTask response: ${text ?? "<empty>"}`,
      );
      return undefined;
    }
    await mcpBridge.callTool("updateTaskStatus", { taskId, status: "ongoing" });
    return taskId;
  } catch (err) {
    console.error("[codex] Failed to create task for elicitation:", err);
    return undefined;
  }
}

/**
 * Ask the human an MCP server's question via agentrq and translate the answer
 * back into codex's response shape.
 *
 * Every failure path resolves to `cancel` rather than throwing: the human being
 * unreachable is a legitimate outcome of asking, not a protocol error, and
 * codex is blocked on this response either way.
 */
export async function resolveElicitation(
  rawParams: unknown,
  deps: ElicitationDeps,
): Promise<ElicitationResponse> {
  const params = rawParams as Record<string, unknown> | undefined;
  const message = typeof params?.message === "string" ? params.message : "";
  const mode = params?.mode;
  const serverName = typeof params?.serverName === "string" ? params.serverName : "unknown";

  const toolArgs: Record<string, unknown> = { message, mode };
  if (mode === "form") {
    toolArgs.requestedSchema = params?.requestedSchema;
  } else if (mode === "url") {
    toolArgs.url = params?.url;
  } else {
    console.error(`[codex] Unsupported elicitation mode "${String(mode)}", cancelling`);
    return { action: "cancel" };
  }

  // Prefer the task the thread is already running; otherwise the question has
  // nowhere to land, so raise a task for it.
  let taskId = deps.resolveTaskId(params?.threadId);
  if (!taskId) {
    taskId = await createTaskForElicitation(deps.mcpBridge, message);
    if (!taskId) {
      console.error("[codex] Elicitation has no task and task creation failed, cancelling");
      return { action: "cancel" };
    }
  }
  toolArgs.taskId = taskId;

  console.error(
    `\n❓ [codex] Elicitation from ${serverName} (mode=${String(mode)}): ${message}`,
  );

  try {
    const result = await deps.mcpBridge.callTool("elicit", toolArgs);
    const text = firstText(result);
    if (!text) {
      console.error("[codex] Elicit tool returned no content, cancelling");
      return { action: "cancel" };
    }
    if ((result as { isError?: unknown }).isError) {
      console.error(`[codex] Elicit tool call failed: ${text}`);
      return { action: "cancel" };
    }

    const parsed = JSON.parse(text) as {
      action?: string;
      content?: Record<string, unknown>;
    };
    if (parsed.action === "accept") {
      return { action: "accept", content: parsed.content };
    }
    if (parsed.action === "decline") {
      return { action: "decline" };
    }
    return { action: "cancel" };
  } catch (err) {
    console.error("[codex] Failed to process elicitation request:", err);
    return { action: "cancel" };
  }
}
