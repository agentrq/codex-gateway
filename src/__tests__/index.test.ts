import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { buildTaskPrompt, handleTask, checkForNextTask } from "../index.js";

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

    it("should auto-allow agentrq tool calls without asking the human", async () => {
      const threadMap = new Map<string, string>();

      mockCodexClient.waitForTurnCompletion = vi.fn().mockImplementation(async () => {
        mockCodexClient.emit("server-request:item/commandExecution/requestApproval", {
          id: 0,
          params: {
            reason: "Call reply tool",
            tool_title: "reply (agentrq-0cHdAEOUJvN)",
            connector_id: "agentrq-0cHdAEOUJvN",
          },
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

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getNextTask");
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
      let getNextTaskCalls = 0;
      mockMcpBridge.callTool.mockImplementation((name: string) => {
        if (name === "getNextTask") {
          getNextTaskCalls++;
          if (getNextTaskCalls === 1) {
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

      expect(getNextTaskCalls).toBe(2);
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
