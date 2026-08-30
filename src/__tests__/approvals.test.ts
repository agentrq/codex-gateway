import { describe, it, expect } from "vitest";
import {
  resolveThreadPolicy,
  describeItem,
  ThreadItemRegistry,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX,
} from "../approvals.js";

describe("resolveThreadPolicy", () => {
  it("should default to the conservative policy/sandbox pair", () => {
    const policy = resolveThreadPolicy({});
    expect(policy.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY);
    expect(policy.sandbox).toBe(DEFAULT_SANDBOX);
    expect(policy.warnings).toEqual([]);
  });

  it("should honor CODEX_APPROVAL_POLICY", () => {
    const policy = resolveThreadPolicy({ CODEX_APPROVAL_POLICY: "untrusted" });
    expect(policy.approvalPolicy).toBe("untrusted");
    expect(policy.warnings).toEqual([]);
  });

  it("should honor CODEX_SANDBOX", () => {
    const policy = resolveThreadPolicy({ CODEX_SANDBOX: "workspace-write" });
    expect(policy.sandbox).toBe("workspace-write");
    expect(policy.warnings).toEqual([]);
  });

  it("should treat an empty value as unset", () => {
    const policy = resolveThreadPolicy({ CODEX_APPROVAL_POLICY: "", CODEX_SANDBOX: "" });
    expect(policy.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY);
    expect(policy.sandbox).toBe(DEFAULT_SANDBOX);
    expect(policy.warnings).toEqual([]);
  });

  it("should fall back to the default and warn on an unrecognized policy", () => {
    const policy = resolveThreadPolicy({ CODEX_APPROVAL_POLICY: "yolo" });
    expect(policy.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY);
    expect(policy.warnings.join(" ")).toContain("CODEX_APPROVAL_POLICY");
  });

  it("should fall back to the default and warn on an unrecognized sandbox", () => {
    const policy = resolveThreadPolicy({ CODEX_SANDBOX: "wide-open" });
    expect(policy.sandbox).toBe(DEFAULT_SANDBOX);
    expect(policy.warnings.join(" ")).toContain("CODEX_SANDBOX");
  });

  it("should warn that a 'never' policy keeps approvals away from the human", () => {
    const policy = resolveThreadPolicy({ CODEX_APPROVAL_POLICY: "never" });
    expect(policy.approvalPolicy).toBe("never");
    expect(policy.warnings.join(" ")).toContain("never request approval");
  });

  it("should warn about a full-access sandbox", () => {
    const policy = resolveThreadPolicy({ CODEX_SANDBOX: "danger-full-access" });
    expect(policy.sandbox).toBe("danger-full-access");
    expect(policy.warnings.join(" ")).toContain("removes the sandbox boundary");
  });

  it("should report both warnings when the pair fully bypasses review", () => {
    const policy = resolveThreadPolicy({
      CODEX_APPROVAL_POLICY: "never",
      CODEX_SANDBOX: "danger-full-access",
    });
    expect(policy.warnings).toHaveLength(2);
  });
});

describe("describeItem", () => {
  it("should describe a command execution with its cwd", () => {
    const d = describeItem({
      id: "i1",
      type: "commandExecution",
      command: "npm test",
      cwd: "/repo",
    });
    expect(d).toEqual({
      title: "npm test",
      inputPreview: "npm test\n(cwd: /repo)",
    });
  });

  it("should describe a command execution without a cwd", () => {
    const d = describeItem({ id: "i1", type: "commandExecution", command: "ls" });
    expect(d?.inputPreview).toBe("ls");
  });

  it("should describe an MCP tool call as server.tool and expose the server", () => {
    const d = describeItem({
      id: "i2",
      type: "mcpToolCall",
      server: "agentrq-0cHdAEOUJvN",
      tool: "reply",
      arguments: { chatId: "c1" },
    });
    expect(d?.title).toBe("agentrq-0cHdAEOUJvN.reply");
    expect(d?.server).toBe("agentrq-0cHdAEOUJvN");
    expect(d?.inputPreview).toBe('{"chatId":"c1"}');
  });

  it("should describe a file change by path count and list the paths", () => {
    const d = describeItem({
      id: "i3",
      type: "fileChange",
      changes: [{ path: "/a.ts" }, { path: "/b.ts" }],
    });
    expect(d?.title).toBe("Edit 2 files");
    expect(d?.inputPreview).toBe("/a.ts\n/b.ts");
  });

  it("should singularize a one-file change", () => {
    const d = describeItem({ id: "i4", type: "fileChange", changes: [{ path: "/a.ts" }] });
    expect(d?.title).toBe("Edit 1 file");
  });

  it("should still describe a file change with no readable paths", () => {
    const d = describeItem({ id: "i5", type: "fileChange", changes: [] });
    expect(d?.title).toBe("File change");
  });

  it("should ignore item types that are never approved", () => {
    expect(describeItem({ id: "i6", type: "agentMessage", text: "hi" })).toBeUndefined();
    expect(describeItem({ id: "i7", type: "reasoning" })).toBeUndefined();
  });

  it("should ignore a command execution with no command", () => {
    expect(describeItem({ id: "i8", type: "commandExecution" })).toBeUndefined();
  });

  it("should handle malformed input", () => {
    expect(describeItem(undefined)).toBeUndefined();
    expect(describeItem(null)).toBeUndefined();
    expect(describeItem("nope")).toBeUndefined();
  });
});

describe("ThreadItemRegistry", () => {
  it("should record and return a describable item", () => {
    const r = new ThreadItemRegistry();
    r.record({ id: "a", type: "commandExecution", command: "ls" });
    expect(r.get("a")?.title).toBe("ls");
    expect(r.size).toBe(1);
  });

  it("should not record items that cannot be described", () => {
    const r = new ThreadItemRegistry();
    r.record({ id: "a", type: "agentMessage", text: "hi" });
    expect(r.size).toBe(0);
  });

  it("should ignore items without a usable id", () => {
    const r = new ThreadItemRegistry();
    r.record({ type: "commandExecution", command: "ls" });
    r.record({ id: 42, type: "commandExecution", command: "ls" });
    expect(r.size).toBe(0);
  });

  it("should return undefined for an unknown or non-string id", () => {
    const r = new ThreadItemRegistry();
    expect(r.get("missing")).toBeUndefined();
    expect(r.get(undefined)).toBeUndefined();
    expect(r.get(7)).toBeUndefined();
  });

  it("should forget an item so the map stays bounded", () => {
    const r = new ThreadItemRegistry();
    r.record({ id: "a", type: "commandExecution", command: "ls" });
    r.forget("a");
    expect(r.get("a")).toBeUndefined();
    expect(r.size).toBe(0);
  });

  it("should clear every entry", () => {
    const r = new ThreadItemRegistry();
    r.record({ id: "a", type: "commandExecution", command: "ls" });
    r.record({ id: "b", type: "commandExecution", command: "pwd" });
    r.clear();
    expect(r.size).toBe(0);
  });
});
