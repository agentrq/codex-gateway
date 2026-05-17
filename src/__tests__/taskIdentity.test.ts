import { describe, it, expect } from "vitest";
import { extractTaskIdFromMeta, extractTaskIdFromText } from "../taskIdentity.js";

describe("taskIdentity", () => {
  describe("extractTaskIdFromMeta", () => {
    it("should return chat_id from meta object", () => {
      expect(extractTaskIdFromMeta({ chat_id: "abc123" })).toBe("abc123");
    });

    it("should return undefined for missing chat_id", () => {
      expect(extractTaskIdFromMeta({ other: "value" })).toBeUndefined();
    });

    it("should return undefined for empty string chat_id", () => {
      expect(extractTaskIdFromMeta({ chat_id: "" })).toBeUndefined();
    });

    it("should return undefined for null meta", () => {
      expect(extractTaskIdFromMeta(null)).toBeUndefined();
    });

    it("should return undefined for non-object meta", () => {
      expect(extractTaskIdFromMeta("string")).toBeUndefined();
      expect(extractTaskIdFromMeta(42)).toBeUndefined();
    });

    it("should return undefined for non-string chat_id", () => {
      expect(extractTaskIdFromMeta({ chat_id: 123 })).toBeUndefined();
    });
  });

  describe("extractTaskIdFromText", () => {
    it("should extract task ID from agentrq getNextTask format", () => {
      expect(
        extractTaskIdFromText("Next assigned task: ID: 0cHj7oddOUb Title: echo what I say"),
      ).toBe("0cHj7oddOUb");
    });

    it("should extract task ID from 'Task ID: <id>' pattern", () => {
      expect(extractTaskIdFromText("Task ID: T1\nsome content")).toBe("T1");
    });

    it("should extract task ID from 'Response to task <id>' pattern", () => {
      expect(extractTaskIdFromText("Response to task abc-123")).toBe("abc-123");
    });

    it("should extract task ID from 'task <id>' pattern", () => {
      expect(extractTaskIdFromText("task 0cHed0a5Pqj")).toBe("0cHed0a5Pqj");
    });

    it("should return undefined when no task ID found", () => {
      expect(extractTaskIdFromText("Hello world")).toBeUndefined();
      expect(extractTaskIdFromText("")).toBeUndefined();
    });

    it("should be case-insensitive", () => {
      expect(extractTaskIdFromText("TASK ID: XYZ")).toBe("XYZ");
    });
  });
});
