/**
 * AgentLoop is the sole tool-calling orchestrator: it drives the provider
 * round by round, executes read/low-effect tools automatically, gates every
 * other tool behind inline user approval, and never claims an action
 * succeeded unless its tool result says ok.
 *
 * Every generated item is persisted immediately via `onItem` — AgentLoop
 * itself never writes conversation/checkpoint storage — and it never
 * imports OpenAI types; all provider-specific translation stays inside
 * `lib/providers/openai.ts`.
 *
 * Hard turn/action limits are intentionally not enforced yet (tracked via
 * `#round`/`#executedCallIds.size` so they can be added later without
 * restructuring the loop).
 */

import type { SidebarHub } from "@/lib/background/sidebar-hub";
import type { TabController } from "@/lib/background/tab-controller";
import { PAGE_TOOL_DEFINITIONS, riskForTool } from "@/lib/domain/tools";
import type { ContextArtifact, JsonValue, PageNode, PageSnapshotV1, ToolCall, ToolResult } from "@/lib/domain/tools";
import type { ConversationItem } from "@/lib/domain/conversation";
import type { ProviderAdapter, ProviderAuth, ReasoningEffort } from "@/lib/domain/provider";
import type { ApprovalRequest, NormalizedError } from "@/lib/protocol";
import {
  isRecord,
  validateClickArgs,
  validateFillArgs,
  validateGoBackArgs,
  validateNavigateArgs,
  validateScrollArgs,
  validateSelectOptionArgs,
  validateSetCheckedArgs,
  validateSnapshotArgs,
} from "@/lib/validation";
import { ProviderStreamError } from "@/lib/providers/openai";

export interface AgentLoopParams {
  runId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  /** Persisted transcript so far, including the just-appended user message. */
  transcript: readonly ConversationItem[];
  contextArtifact: ContextArtifact | null;
  auth: ProviderAuth;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  /** Called immediately for every item generated this run, before continuing. */
  onItem: (item: ConversationItem) => Promise<void>;
  /** Called whenever the pending-approval gate opens or closes for this run. */
  onApprovalPending: (request: ApprovalRequest | null) => void;
}

export type AgentLoopResult =
  | { status: "completed"; finalMessageId: string | null }
  | { status: "cancelled"; partialText: string }
  | { status: "failed"; error: NormalizedError; hadPageEffect: boolean };

const AUTO_RUN_RISKS = new Set(["read", "low-effect"]);

export class AgentLoop {
  #provider: ProviderAdapter;
  #tabController: TabController;
  #sidebarHub: SidebarHub;
  #executedCallIds = new Map<string, ToolResult>();
  #hadPageEffect = false;
  #pendingApprovals = new Map<string, (approved: boolean) => void>();
  #round = 0;
  #latestSnapshot: PageSnapshotV1 | null = null;

  constructor(provider: ProviderAdapter, tabController: TabController, sidebarHub: SidebarHub) {
    this.#provider = provider;
    this.#tabController = tabController;
    this.#sidebarHub = sidebarHub;
  }

  /** Resolves the pending approval gate for `callId`, if one is waiting on this run. */
  approve(callId: string): void {
    this.#resolveApproval(callId, true);
  }

  deny(callId: string): void {
    this.#resolveApproval(callId, false);
  }

  #resolveApproval(callId: string, approved: boolean): void {
    const resolve = this.#pendingApprovals.get(callId);
    if (!resolve) return;
    this.#pendingApprovals.delete(callId);
    resolve(approved);
  }

  async run(params: AgentLoopParams): Promise<AgentLoopResult> {
    if (params.contextArtifact) this.#latestSnapshot = params.contextArtifact.snapshot;

    const transcript = [...params.transcript];
    let replayState: JsonValue | null = null;
    let lastMessageId: string | null = null;

    while (true) {
      this.#round += 1;
      let roundText = "";
      const pendingCalls: ToolCall[] = [];

      try {
        const stream = this.#provider.streamTurn(
          {
            modelId: params.modelId,
            reasoningEffort: params.reasoningEffort,
            transcript,
            contextArtifacts: params.contextArtifact ? [params.contextArtifact] : [],
            replayState,
            tools: PAGE_TOOL_DEFINITIONS,
          },
          params.auth,
          params.signal,
        );
        for await (const event of stream) {
          if (event.type === "text.delta") {
            roundText += event.delta;
            params.onDelta(event.delta);
          } else if (event.type === "tool.call") {
            pendingCalls.push(event.call);
          } else if (event.type === "turn.completed") {
            replayState = event.replayState;
          }
        }
      } catch (error) {
        if (params.signal.aborted) return { status: "cancelled", partialText: roundText };
        return { status: "failed", error: toNormalizedError(error), hadPageEffect: this.#hadPageEffect };
      }

      if (params.signal.aborted) {
        return { status: "cancelled", partialText: roundText };
      }
      if (roundText) {
        const message: ConversationItem = { id: crypto.randomUUID(), kind: "message", role: "assistant", text: roundText, at: Date.now() };
        transcript.push(message);
        await params.onItem(message);
        lastMessageId = message.id;
      }

      if (pendingCalls.length === 0) {
        return { status: "completed", finalMessageId: lastMessageId };
      }

      for (const call of pendingCalls) {
        const callItem: ConversationItem = { id: crypto.randomUUID(), kind: "tool-call", call, at: Date.now() };
        transcript.push(callItem);
        await params.onItem(callItem);

        const result = await this.#executeCall(params, call);

        if (params.signal.aborted) {
          return { status: "cancelled", partialText: "" };
        }

        const resultItem: ConversationItem = {
          id: crypto.randomUUID(),
          kind: "tool-result",
          callId: call.id,
          result: stripData(result),
          at: Date.now(),
        };
        transcript.push(resultItem);
        await params.onItem(resultItem);
      }
    }
  }

  async #executeCall(params: AgentLoopParams, call: ToolCall): Promise<ToolResult> {
    const recorded = this.#executedCallIds.get(call.id);
    if (recorded) return recorded;

    if (!isValidCallShape(call)) {
      const invalid: ToolResult = { ok: false, code: "INVALID_TOOL_ARGUMENTS", summary: "Invalid or missing arguments for this tool call." };
      this.#executedCallIds.set(call.id, invalid);
      return invalid;
    }

    const risk = riskForTool(call.name);
    if (AUTO_RUN_RISKS.has(risk)) {
      this.#sidebarHub.publishRunEvent(params.runId, "tool.requested", { call, display: describeCall(call, this.#latestSnapshot).display });
    } else {
      const { display, target } = describeCall(call, this.#latestSnapshot);
      const request: ApprovalRequest = { call, origin: this.#latestSnapshot?.origin ?? "", display, target };
      this.#sidebarHub.publishRunEvent(params.runId, "action.approval-required", request);
      params.onApprovalPending(request);

      const approved = await this.#waitForApproval(call.id, params.signal);
      params.onApprovalPending(null);

      if (params.signal.aborted) {
        // Cancellation resolves the gate without running the action; the run
        // loop's own abort check right after this call handles the terminal
        // transition.
        return { ok: false, code: "ACTION_DENIED", summary: "Cancelled before approval." };
      }
      if (!approved) {
        const denied: ToolResult = { ok: false, code: "ACTION_DENIED", summary: "The user denied this action." };
        this.#executedCallIds.set(call.id, denied);
        this.#sidebarHub.publishRunEvent(params.runId, "tool.result", { callId: call.id, result: denied });
        return denied;
      }
    }

    const outcome = await this.#tabController.execute(call);
    if (outcome.snapshot) this.#latestSnapshot = outcome.snapshot;
    if (risk === "consequential" && outcome.result.ok) this.#hadPageEffect = true;
    this.#executedCallIds.set(call.id, outcome.result);
    this.#sidebarHub.publishRunEvent(params.runId, "tool.result", { callId: call.id, result: outcome.result });
    return outcome.result;
  }

  /** A pending approval has no timeout; only approve/deny or the run's abort signal resolves it. */
  #waitForApproval(callId: string, signal: AbortSignal): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.#pendingApprovals.set(callId, resolve);
    const onAbort = () => {
      this.#pendingApprovals.delete(callId);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return promise.finally(() => signal.removeEventListener("abort", onAbort));
  }
}

function isValidCallShape(call: ToolCall): boolean {
  if (call.name === "page_snapshot") return validateSnapshotArgs(call.arguments) !== null;
  if (call.name === "page_click") return validateClickArgs(call.arguments) !== null;
  if (call.name === "page_fill") return validateFillArgs(call.arguments) !== null;
  if (call.name === "page_select_option") return validateSelectOptionArgs(call.arguments) !== null;
  if (call.name === "page_set_checked") return validateSetCheckedArgs(call.arguments) !== null;
  if (call.name === "page_scroll") return validateScrollArgs(call.arguments) !== null;
  if (call.name === "page_navigate") return validateNavigateArgs(call.arguments) !== null;
  if (call.name === "page_go_back") return validateGoBackArgs(call.arguments) !== null;
  return false;
}

function stripData(result: ToolResult): Omit<ToolResult, "data"> {
  const { data: _data, ...rest } = result;
  return rest;
}

function describeCall(
  call: ToolCall,
  snapshot: PageSnapshotV1 | null,
): { display: string; target: { ref?: string; role?: string; name?: string } } {
  const args = call.arguments;
  const ref = isRecord(args) && typeof args.ref === "string" ? args.ref : undefined;
  const node: PageNode | undefined = ref ? snapshot?.nodes.find((candidate) => candidate.ref === ref) : undefined;
  const label = node?.name || ref || "";
  const target = { ref, role: node?.role, name: node?.name };

  if (call.name === "page_click") return { display: `page.click(${JSON.stringify(label)})`, target };
  if (call.name === "page_fill") {
    const text = isRecord(args) && typeof args.text === "string" ? args.text : "";
    return { display: `page.fill(${JSON.stringify(label)}, ${JSON.stringify(text)})`, target };
  }
  if (call.name === "page_select_option") {
    const values = isRecord(args) && Array.isArray(args.values) ? args.values : [];
    return { display: `page.selectOption(${JSON.stringify(label)}, ${JSON.stringify(values)})`, target };
  }
  if (call.name === "page_set_checked") {
    const checked = isRecord(args) ? args.checked : undefined;
    return { display: `page.setChecked(${JSON.stringify(label)}, ${String(checked)})`, target };
  }
  if (call.name === "page_navigate") {
    const url = isRecord(args) && typeof args.url === "string" ? args.url : "";
    return { display: `page.navigate(${JSON.stringify(url)})`, target: {} };
  }
  if (call.name === "page_go_back") return { display: "page.goBack()", target: {} };
  return { display: call.name, target };
}

function toNormalizedError(error: unknown): NormalizedError {
  if (error instanceof ProviderStreamError) {
    return { code: error.code, message: error.message, retryable: error.retryable, phase: "provider", status: error.status, requestId: error.requestId };
  }
  const message = error instanceof Error ? error.message : "Unknown error.";
  return { code: "PROTOCOL_ERROR", message, retryable: false, phase: "provider" };
}
