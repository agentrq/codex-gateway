/**
 * approvals.ts
 *
 * Approval-routing support for the Codex app server.
 *
 * Two concerns live here:
 *
 * 1. Resolving a thread's approval policy and sandbox from the environment,
 *    and flagging combinations that let the agent act without the human ever
 *    seeing an approval request in agentrq.
 * 2. Remembering thread items as they start, so an approval request — which
 *    identifies its subject only by `itemId` — can be described to the human
 *    with a real name and input preview instead of "Unknown command".
 */

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
];

export const SANDBOX_MODES: readonly SandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

/**
 * Defaults are the conservative pair documented for agentrq workspaces:
 * the agent asks before acting, and cannot write outside the sandbox
 * without asking first.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "on-request";
export const DEFAULT_SANDBOX: SandboxMode = "read-only";

export interface ThreadPolicy {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  /** Human-readable problems worth logging prominently before the thread starts. */
  warnings: string[];
}

function pickEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  varName: string,
  warnings: string[],
): T {
  if (raw === undefined || raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  warnings.push(
    `${varName}="${raw}" is not one of ${allowed.join(", ")} — falling back to "${fallback}".`,
  );
  return fallback;
}

/**
 * Resolve the approval policy and sandbox for new threads.
 *
 * Both are honored from the environment, but an unrecognized value falls back
 * to the safe default rather than being passed through to codex, and any
 * setting that removes the human from the loop is reported in `warnings`.
 */
export function resolveThreadPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ThreadPolicy {
  const warnings: string[] = [];

  const approvalPolicy = pickEnum(
    env.CODEX_APPROVAL_POLICY,
    APPROVAL_POLICIES,
    DEFAULT_APPROVAL_POLICY,
    "CODEX_APPROVAL_POLICY",
    warnings,
  );
  const sandbox = pickEnum(
    env.CODEX_SANDBOX,
    SANDBOX_MODES,
    DEFAULT_SANDBOX,
    "CODEX_SANDBOX",
    warnings,
  );

  // With "never", codex decides every command on its own and never sends an
  // approval request, so nothing reaches the agentrq dashboard for review.
  if (approvalPolicy === "never") {
    warnings.push(
      'CODEX_APPROVAL_POLICY="never" means codex will never request approval — ' +
        "tool calls will run without reaching agentrq for human review.",
    );
  }

  // A full-access sandbox lets commands touch anything on the machine; combined
  // with a policy that rarely escalates, most actions never prompt at all.
  if (sandbox === "danger-full-access") {
    warnings.push(
      'CODEX_SANDBOX="danger-full-access" removes the sandbox boundary — ' +
        "commands can read and write anywhere the gateway process can.",
    );
  }

  return { approvalPolicy, sandbox, warnings };
}

/** What the human is shown in agentrq for a pending approval. */
export interface ItemDescriptor {
  /** Short name for the action, e.g. the command line or `server.tool`. */
  title: string;
  /** Fuller detail rendered as the input preview. */
  inputPreview: string;
  /** MCP server name, when the item is an MCP tool call. */
  server?: string;
}

function previewJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Build a descriptor for a `ThreadItem` from an `item/started` notification.
 *
 * Returns undefined for item types that are never the subject of an approval
 * request (assistant messages, reasoning, and so on), so the registry only
 * holds entries that can actually be asked about.
 */
export function describeItem(item: unknown): ItemDescriptor | undefined {
  if (!item || typeof item !== "object") return undefined;
  const it = item as Record<string, unknown>;

  switch (it.type) {
    case "commandExecution": {
      const command = typeof it.command === "string" ? it.command : "";
      const cwd = typeof it.cwd === "string" ? it.cwd : "";
      if (!command) return undefined;
      return {
        title: command,
        inputPreview: cwd ? `${command}\n(cwd: ${cwd})` : command,
      };
    }

    case "mcpToolCall": {
      const server = typeof it.server === "string" ? it.server : "";
      const tool = typeof it.tool === "string" ? it.tool : "";
      if (!server && !tool) return undefined;
      return {
        title: server && tool ? `${server}.${tool}` : server || tool,
        inputPreview: previewJson(it.arguments),
        server: server || undefined,
      };
    }

    case "fileChange": {
      const changes = it.changes;
      const paths = Array.isArray(changes)
        ? changes
            .map((c) =>
              c && typeof c === "object"
                ? (c as Record<string, unknown>).path
                : undefined,
            )
            .filter((p): p is string => typeof p === "string")
        : [];
      const title =
        paths.length > 0
          ? `Edit ${paths.length} file${paths.length === 1 ? "" : "s"}`
          : "File change";
      return { title, inputPreview: paths.join("\n") };
    }

    default:
      return undefined;
  }
}

/**
 * Remembers in-flight thread items by id.
 *
 * Codex sends an approval request carrying only `{ itemId, threadId, turnId }`
 * plus an optional free-text `reason`; the command or tool it refers to was
 * announced earlier in an `item/started` notification. Holding onto those lets
 * an approval be presented with a real name and input.
 *
 * Entries are dropped as items complete so the map stays bounded to whatever is
 * actually in flight rather than growing for the life of a thread.
 */
export class ThreadItemRegistry {
  private items = new Map<string, ItemDescriptor>();

  /** Record the item from an `item/started` notification payload. */
  record(item: unknown): void {
    if (!item || typeof item !== "object") return;
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) return;
    const descriptor = describeItem(item);
    if (descriptor) this.items.set(id, descriptor);
  }

  get(itemId: unknown): ItemDescriptor | undefined {
    return typeof itemId === "string" ? this.items.get(itemId) : undefined;
  }

  /** Drop an item once it reaches a terminal state. */
  forget(itemId: unknown): void {
    if (typeof itemId === "string") this.items.delete(itemId);
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
