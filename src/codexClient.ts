/**
 * codexClient.ts
 *
 * JSON-RPC 2.0 client for the Codex app server.
 * Communicates over stdio (JSONL) — the wire format omits the "jsonrpc":"2.0" header
 * as documented in the Codex app-server protocol spec.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface ThreadStartParams {
  cwd?: string;
  model?: string;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    error?: { message: string } | null;
  };
}

export class CodexClient extends EventEmitter {
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdin: NodeJS.WritableStream | null = null;
  private process: ChildProcess | null = null;

  constructor(
    private command: string = "codex",
    private cmdArgs: string[] = ["app-server"],
  ) {
    super();
  }

  async start(): Promise<void> {
    const proc = spawn(this.command, this.cmdArgs, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.process = proc;
    this.stdin = proc.stdin!;

    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        this._handleMessage(msg);
      } catch (err) {
        console.error("[codex] Failed to parse line:", trimmed.slice(0, 120), err);
      }
    });

    proc.on("exit", (code) => {
      console.error(`[codex] Process exited with code ${code}`);
      this.emit("exit", code);
    });

    await this._initialize();
  }

  private async _initialize(): Promise<void> {
    await this._request("initialize", {
      clientInfo: {
        name: "codex-gateway",
        title: "Codex Gateway for AgentRQ",
        version: "0.1.0",
      },
      capabilities: {},
    });
    this._sendNotification("initialized");
    console.error("[codex] Connected to codex app-server");
  }

  _handleMessage(msg: Record<string, unknown>): void {
    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      // Server-initiated request (e.g., elicitation/create for approval)
      const method = msg.method as string;
      this.emit(`server-request:${method}`, { id: msg.id as number, params: msg.params });
    } else if ("id" in msg && msg.id !== undefined) {
      const id = msg.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg.error) {
          const err = msg.error as { message: string; code: number };
          pending.reject(new Error(`${err.message} (code ${err.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ("method" in msg) {
      const method = msg.method as string;
      this.emit(`notification:${method}`, msg.params);
    }
  }

  _sendResponse(id: number, result: unknown): void {
    this._send({ id, result });
  }

  _request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { method, id };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this._send(msg);
    });
  }

  _sendNotification(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this._send(msg);
  }

  _send(msg: unknown): void {
    if (!this.stdin) throw new Error("CodexClient not started — call start() first");
    this.stdin.write(JSON.stringify(msg) + "\n");
  }

  async startThread(params: ThreadStartParams = {}): Promise<string> {
    const reqParams: Record<string, unknown> = {
      cwd: params.cwd ?? process.cwd(),
      approvalPolicy: params.approvalPolicy ?? "on-request",
      sandbox: params.sandbox ?? "read-only",
    };
    if (params.model) reqParams.model = params.model;

    const result = (await this._request("thread/start", reqParams)) as {
      thread: { id: string };
    };
    return result.thread.id;
  }

  async startTurn(threadId: string, text: string, model?: string): Promise<string> {
    const reqParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text }],
    };
    if (model) reqParams.model = model;

    const result = (await this._request("turn/start", reqParams)) as {
      turn: { id: string };
    };
    return result.turn.id;
  }

  waitForTurnCompletion(threadId: string, turnId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const onCompleted = (params: TurnCompletedNotification) => {
        if (params.threadId !== threadId || params.turn.id !== turnId) return;
        this.off("notification:turn/completed", onCompleted);
        if (params.turn.status === "failed") {
          reject(
            new Error(`Turn failed: ${params.turn.error?.message ?? "unknown error"}`),
          );
        } else {
          resolve(params.turn.status);
        }
      };
      this.on("notification:turn/completed", onCompleted);
    });
  }

  close(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.stdin = null;
    }
  }
}
