import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexClient } from "../codexClient.js";

describe("CodexClient", () => {
  let client: CodexClient;
  let mockWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new CodexClient();
    mockWrite = vi.fn();
    (client as any).stdin = { write: mockWrite };
  });

  describe("_handleMessage", () => {
    it("should resolve a pending request on success response", async () => {
      const resultPromise = (client as any)._request("test-method");
      const requestId = (client as any).nextId - 1;

      (client as any)._handleMessage({ id: requestId, result: { foo: "bar" } });

      const result = await resultPromise;
      expect(result).toEqual({ foo: "bar" });
    });

    it("should reject a pending request on error response", async () => {
      const resultPromise = (client as any)._request("test-method");
      const requestId = (client as any).nextId - 1;

      (client as any)._handleMessage({
        id: requestId,
        error: { code: -32600, message: "Invalid request" },
      });

      await expect(resultPromise).rejects.toThrow("Invalid request (code -32600)");
    });

    it("should emit notification event for messages without id", () => {
      const handler = vi.fn();
      client.on("notification:turn/completed", handler);

      (client as any)._handleMessage({
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn1", status: "completed" } },
      });

      expect(handler).toHaveBeenCalledWith({
        threadId: "t1",
        turn: { id: "turn1", status: "completed" },
      });
    });

    it("should emit notification with undefined params when absent", () => {
      const handler = vi.fn();
      client.on("notification:initialized", handler);

      (client as any)._handleMessage({ method: "initialized" });

      expect(handler).toHaveBeenCalledWith(undefined);
    });

    it("should not throw for unrecognized responses (no pending request)", () => {
      expect(() => {
        (client as any)._handleMessage({ id: 999, result: "orphan" });
      }).not.toThrow();
    });

    it("should emit server-request event for messages with both id and method", () => {
      const handler = vi.fn();
      client.on("server-request:item/commandExecution/requestApproval", handler);

      (client as any)._handleMessage({
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: { reason: "Allow Codex to run `rm -rf dist/`?", command: "rm -rf dist/" },
      });

      expect(handler).toHaveBeenCalledWith({
        id: 0,
        params: { reason: "Allow Codex to run `rm -rf dist/`?", command: "rm -rf dist/" },
      });
    });

    it("should not treat server-request as a pending request resolution", async () => {
      const resultPromise = (client as any)._request("some-method");
      const reqId = (client as any).nextId - 1;

      // A server-initiated request with the same id should not resolve our pending request
      (client as any)._handleMessage({ id: reqId, method: "elicitation/create", params: {} });

      // The pending request should still be pending (not resolved or rejected)
      let settled = false;
      resultPromise.then(() => { settled = true; }).catch(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);

      // Clean up
      (client as any)._handleMessage({ id: reqId, result: {} });
      await resultPromise;
    });

    it("should remove pending request after resolution", async () => {
      const resultPromise = (client as any)._request("some-method");
      const id = (client as any).nextId - 1;

      (client as any)._handleMessage({ id, result: {} });
      await resultPromise;

      expect((client as any).pendingRequests.has(id)).toBe(false);
    });
  });

  describe("_request", () => {
    it("should write JSON-RPC request to stdin with incrementing id", () => {
      (client as any)._request("test-method", { key: "value" });

      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringContaining('"method":"test-method"'),
      );
      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringContaining('"key":"value"'),
      );
      const written = mockWrite.mock.calls[0][0] as string;
      expect(written.endsWith("\n")).toBe(true);
    });

    it("should omit params field when not provided", () => {
      (client as any)._request("no-params-method");

      const written = mockWrite.mock.calls[0][0] as string;
      const parsed = JSON.parse(written);
      expect(parsed.params).toBeUndefined();
    });
  });

  describe("_sendNotification", () => {
    it("should write notification without id", () => {
      (client as any)._sendNotification("initialized");

      const written = mockWrite.mock.calls[0][0] as string;
      const parsed = JSON.parse(written);
      expect(parsed.method).toBe("initialized");
      expect(parsed.id).toBeUndefined();
    });
  });

  describe("_sendResponse", () => {
    it("should write response with id and result", () => {
      (client as any)._sendResponse(42, { action: "accept" });

      const written = mockWrite.mock.calls[0][0] as string;
      const parsed = JSON.parse(written);
      expect(parsed.id).toBe(42);
      expect(parsed.result).toEqual({ action: "accept" });
      expect(parsed.method).toBeUndefined();
    });
  });

  describe("startThread", () => {
    it("should call thread/start and return threadId", async () => {
      const requestSpy = vi
        .spyOn(client as any, "_request")
        .mockResolvedValue({ thread: { id: "thr_abc" } });

      const threadId = await client.startThread({
        cwd: "/project",
        model: "o4-mini",
      });

      expect(threadId).toBe("thr_abc");
      expect(requestSpy).toHaveBeenCalledWith(
        "thread/start",
        expect.objectContaining({
          cwd: "/project",
          model: "o4-mini",
          approvalPolicy: "on-request",
          sandbox: "read-only",
        }),
      );
    });

    it("should use defaults when no params provided", async () => {
      const requestSpy = vi
        .spyOn(client as any, "_request")
        .mockResolvedValue({ thread: { id: "thr_default" } });

      await client.startThread();

      expect(requestSpy).toHaveBeenCalledWith(
        "thread/start",
        expect.objectContaining({
          approvalPolicy: "on-request",
          sandbox: "read-only",
        }),
      );
      const params = requestSpy.mock.calls[0][1] as any;
      expect(params.model).toBeUndefined();
    });

    it("should respect custom approvalPolicy", async () => {
      const requestSpy = vi
        .spyOn(client as any, "_request")
        .mockResolvedValue({ thread: { id: "thr_xyz" } });

      await client.startThread({ approvalPolicy: "on-request" });

      expect(requestSpy).toHaveBeenCalledWith(
        "thread/start",
        expect.objectContaining({ approvalPolicy: "on-request" }),
      );
    });

    it("should respect custom sandbox mode", async () => {
      const requestSpy = vi
        .spyOn(client as any, "_request")
        .mockResolvedValue({ thread: { id: "thr_xyz" } });

      await client.startThread({ sandbox: "danger-full-access" });

      expect(requestSpy).toHaveBeenCalledWith(
        "thread/start",
        expect.objectContaining({ sandbox: "danger-full-access" }),
      );
    });
  });

  describe("startTurn", () => {
    it("should call turn/start with text input and return turnId", async () => {
      const requestSpy = vi
        .spyOn(client as any, "_request")
        .mockResolvedValue({ turn: { id: "turn_xyz" } });

      const turnId = await client.startTurn("thr_abc", "Do something", "o4-mini");

      expect(turnId).toBe("turn_xyz");
      expect(requestSpy).toHaveBeenCalledWith("turn/start", {
        threadId: "thr_abc",
        input: [{ type: "text", text: "Do something" }],
        model: "o4-mini",
      });
    });

    it("should omit model when not provided", async () => {
      const requestSpy = vi
        .spyOn(client as any, "_request")
        .mockResolvedValue({ turn: { id: "turn_nomodel" } });

      await client.startTurn("thr_abc", "Do something");

      const params = requestSpy.mock.calls[0][1] as any;
      expect(params.model).toBeUndefined();
    });
  });

  describe("waitForTurnCompletion", () => {
    it("should resolve with 'completed' when turn/completed arrives", async () => {
      const completionPromise = client.waitForTurnCompletion("thr_1", "turn_1");

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });

      const status = await completionPromise;
      expect(status).toBe("completed");
    });

    it("should resolve with 'interrupted' status", async () => {
      const completionPromise = client.waitForTurnCompletion("thr_1", "turn_1");

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "interrupted" },
      });

      const status = await completionPromise;
      expect(status).toBe("interrupted");
    });

    it("should reject when turn status is failed", async () => {
      const completionPromise = client.waitForTurnCompletion("thr_1", "turn_1");

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: {
          id: "turn_1",
          status: "failed",
          error: { message: "Something went wrong" },
        },
      });

      await expect(completionPromise).rejects.toThrow("Something went wrong");
    });

    it("should reject with generic message when error is null", async () => {
      const completionPromise = client.waitForTurnCompletion("thr_1", "turn_1");

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "failed", error: null },
      });

      await expect(completionPromise).rejects.toThrow("unknown error");
    });

    it("should ignore notifications for other threads", async () => {
      let resolved = false;
      const completionPromise = client
        .waitForTurnCompletion("thr_target", "turn_1")
        .then(() => {
          resolved = true;
        });

      client.emit("notification:turn/completed", {
        threadId: "thr_OTHER",
        turn: { id: "turn_1", status: "completed" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Resolve correctly
      client.emit("notification:turn/completed", {
        threadId: "thr_target",
        turn: { id: "turn_1", status: "completed" },
      });
      await completionPromise;
    });

    it("should ignore notifications for other turn IDs", async () => {
      let resolved = false;
      const completionPromise = client
        .waitForTurnCompletion("thr_1", "turn_target")
        .then(() => {
          resolved = true;
        });

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_OTHER", status: "completed" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_target", status: "completed" },
      });
      await completionPromise;
    });

    it("should remove listener after completion", async () => {
      const completionPromise = client.waitForTurnCompletion("thr_1", "turn_1");

      client.emit("notification:turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });

      await completionPromise;
      expect(client.listenerCount("notification:turn/completed")).toBe(0);
    });
  });

  describe("close", () => {
    it("should kill the process and clear state", () => {
      const mockKill = vi.fn();
      (client as any).process = { kill: mockKill };
      (client as any).stdin = { write: vi.fn() };

      client.close();

      expect(mockKill).toHaveBeenCalled();
      expect((client as any).process).toBeNull();
      expect((client as any).stdin).toBeNull();
    });

    it("should not throw when process is already null", () => {
      (client as any).process = null;
      expect(() => client.close()).not.toThrow();
    });
  });
});
