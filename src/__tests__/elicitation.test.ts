import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveElicitation } from "../elicitation.js";

function textResult(text: string, isError = false) {
  return { isError, content: [{ type: "text", text }] };
}

describe("resolveElicitation", () => {
  let callTool: ReturnType<typeof vi.fn>;
  let deps: any;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    callTool = vi.fn();
    deps = { mcpBridge: { callTool }, resolveTaskId: () => "task-1" };
  });

  it("should delegate a form elicitation to the elicit tool with the thread's task", async () => {
    callTool.mockResolvedValue(textResult(JSON.stringify({ action: "accept", content: { name: "mt" } })));

    const result = await resolveElicitation(
      {
        serverName: "some-server",
        threadId: "thr_1",
        mode: "form",
        message: "What is your name?",
        requestedSchema: { type: "object", properties: {} },
      },
      deps,
    );

    expect(callTool).toHaveBeenCalledWith("elicit", {
      taskId: "task-1",
      message: "What is your name?",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result).toEqual({ action: "accept", content: { name: "mt" } });
  });

  it("should pass the url through for url-mode elicitations", async () => {
    callTool.mockResolvedValue(textResult(JSON.stringify({ action: "accept" })));

    await resolveElicitation(
      {
        serverName: "s",
        threadId: "thr_1",
        mode: "url",
        message: "Authorize access",
        url: "https://example.test/auth",
        elicitationId: "e1",
      },
      deps,
    );

    expect(callTool).toHaveBeenCalledWith("elicit", {
      taskId: "task-1",
      message: "Authorize access",
      mode: "url",
      url: "https://example.test/auth",
    });
  });

  it("should map a declined answer", async () => {
    callTool.mockResolvedValue(textResult(JSON.stringify({ action: "decline" })));
    const r = await resolveElicitation({ threadId: "t", mode: "form", message: "m" }, deps);
    expect(r).toEqual({ action: "decline" });
  });

  it("should map an unrecognized action to cancel", async () => {
    callTool.mockResolvedValue(textResult(JSON.stringify({ action: "whatever" })));
    const r = await resolveElicitation({ threadId: "t", mode: "form", message: "m" }, deps);
    expect(r).toEqual({ action: "cancel" });
  });

  it("should cancel an unsupported mode without calling the tool", async () => {
    const r = await resolveElicitation({ threadId: "t", mode: "telepathy", message: "m" }, deps);
    expect(r).toEqual({ action: "cancel" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("should cancel when the elicit tool reports an error", async () => {
    callTool.mockResolvedValue(textResult("boom", true));
    const r = await resolveElicitation({ threadId: "t", mode: "form", message: "m" }, deps);
    expect(r).toEqual({ action: "cancel" });
  });

  it("should cancel when the elicit tool returns no content", async () => {
    callTool.mockResolvedValue({ isError: false, content: [] });
    const r = await resolveElicitation({ threadId: "t", mode: "form", message: "m" }, deps);
    expect(r).toEqual({ action: "cancel" });
  });

  it("should cancel when the elicit tool returns unparseable content", async () => {
    callTool.mockResolvedValue(textResult("not json"));
    const r = await resolveElicitation({ threadId: "t", mode: "form", message: "m" }, deps);
    expect(r).toEqual({ action: "cancel" });
  });

  it("should cancel when the tool call throws", async () => {
    callTool.mockRejectedValue(new Error("offline"));
    const r = await resolveElicitation({ threadId: "t", mode: "form", message: "m" }, deps);
    expect(r).toEqual({ action: "cancel" });
  });

  describe("when the thread has no task", () => {
    beforeEach(() => {
      deps.resolveTaskId = () => undefined;
    });

    it("should create an ongoing task and use it", async () => {
      callTool.mockImplementation(async (name: string) => {
        if (name === "createTask") return textResult("Created task id=task-new");
        if (name === "updateTaskStatus") return textResult("ok");
        return textResult(JSON.stringify({ action: "accept", content: { a: 1 } }));
      });

      const r = await resolveElicitation(
        { threadId: "unknown", mode: "form", message: "Pick one", requestedSchema: {} },
        deps,
      );

      expect(callTool).toHaveBeenCalledWith("createTask", {
        title: "Pick one",
        body: "Pick one",
        assignee: "human",
      });
      expect(callTool).toHaveBeenCalledWith("updateTaskStatus", {
        taskId: "task-new",
        status: "ongoing",
      });
      expect(callTool).toHaveBeenCalledWith(
        "elicit",
        expect.objectContaining({ taskId: "task-new" }),
      );
      expect(r).toEqual({ action: "accept", content: { a: 1 } });
    });

    it("should truncate a long message into the task title", async () => {
      const long = "x".repeat(200);
      callTool.mockImplementation(async (name: string) => {
        if (name === "createTask") return textResult("id=t2");
        if (name === "updateTaskStatus") return textResult("ok");
        return textResult(JSON.stringify({ action: "decline" }));
      });

      await resolveElicitation({ threadId: "u", mode: "form", message: long }, deps);

      const call = callTool.mock.calls.find((c) => c[0] === "createTask");
      expect(call?.[1].title).toHaveLength(80);
      expect(call?.[1].title.endsWith("...")).toBe(true);
      expect(call?.[1].body).toBe(long);
    });

    it("should cancel when the created task id cannot be parsed", async () => {
      callTool.mockResolvedValue(textResult("something unexpected"));
      const r = await resolveElicitation({ threadId: "u", mode: "form", message: "m" }, deps);
      expect(r).toEqual({ action: "cancel" });
      expect(callTool).not.toHaveBeenCalledWith("elicit", expect.anything());
    });

    it("should cancel when task creation throws", async () => {
      callTool.mockRejectedValue(new Error("nope"));
      const r = await resolveElicitation({ threadId: "u", mode: "form", message: "m" }, deps);
      expect(r).toEqual({ action: "cancel" });
    });
  });
});
