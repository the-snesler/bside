/**
 * Preact hook connecting a UI surface to the background's
 * "agent-sidebar:v1" Port. The sidebar renders this state; it never owns an
 * inference request, tool loop, transcript authority, or credential read.
 * Between full `state.snapshot` syncs, run-lifecycle events are applied
 * incrementally so the composer/timeline update live without re-fetching.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Browser } from "wxt/browser";
import { RUN_CANCELLED_SUFFIX, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { NormalizedError, RuntimeSnapshot, SidebarCommand, SidebarEvent } from "@/lib/protocol";
import type { ConversationItem } from "@/lib/domain/conversation";

export interface BackgroundState extends RuntimeSnapshot {
  lastError: NormalizedError | null;
}

export interface BackgroundActions {
  sendPrompt(prompt: string): void;
  cancelRun(): void;
  approveAction(callId: string): void;
  denyAction(callId: string): void;
  resetContext(): void;
  downloadContext(): void;
}

const INITIAL_STATE: BackgroundState = {
  conversation: { version: 1, id: "default", items: [], updatedAt: 0 },
  credential: { configured: false, maskedSuffix: null },
  settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
  page: null,
  activeRun: null,
  lastSeq: 0,
  notice: null,
  lastError: null,
};

type Port = Browser.runtime.Port;

export function useBackground(): BackgroundState & BackgroundActions {
  const [state, setState] = useState<BackgroundState>(INITIAL_STATE);
  const portRef = useRef<Port | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const exportRequestRef = useRef<string | null>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: SIDEBAR_PORT_NAME });
    portRef.current = port;

    const onMessage = (message: unknown) => {
      const event = message as SidebarEvent;
      if (event.type === "context.exported") {
        if (event.payload.requestId !== exportRequestRef.current) return;
        exportRequestRef.current = null;
        const url = URL.createObjectURL(new Blob([event.payload.markdown], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = event.payload.filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      applyEvent(message as SidebarEvent, setState, activeRunIdRef);
    };
    port.onMessage.addListener(onMessage);

    const subscribe: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "state.subscribe", lastSeq: null };
    port.postMessage(subscribe);

    return () => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  const sendPrompt = useCallback((prompt: string) => {
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "run.start", prompt };
    portRef.current?.postMessage(command);
  }, []);

  const cancelRun = useCallback(() => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "run.cancel", runId };
    portRef.current?.postMessage(command);
  }, []);

  const approveAction = useCallback((callId: string) => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "action.approve", runId, callId };
    portRef.current?.postMessage(command);
  }, []);

  const denyAction = useCallback((callId: string) => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "action.deny", runId, callId };
    portRef.current?.postMessage(command);
  }, []);

  const resetContext = useCallback(() => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "context.reset" } satisfies SidebarCommand);
  }, []);

  const downloadContext = useCallback(() => {
    const id = crypto.randomUUID();
    exportRequestRef.current = id;
    portRef.current?.postMessage({ v: 1, id, type: "context.export" } satisfies SidebarCommand);
  }, []);

  return { ...state, sendPrompt, cancelRun, approveAction, denyAction, resetContext, downloadContext };
}

function commitPendingText(prev: BackgroundState): BackgroundState {
  if (!prev.activeRun || !prev.activeRun.partialAssistantText) return prev;
  const message: ConversationItem = {
    id: `${prev.activeRun.runId}-msg-${prev.conversation.items.length}`,
    kind: "message",
    role: "assistant",
    text: prev.activeRun.partialAssistantText,
    at: Date.now(),
  };
  return {
    ...prev,
    activeRun: { ...prev.activeRun, partialAssistantText: "" },
    conversation: { ...prev.conversation, items: [...prev.conversation.items, message] },
  };
}

function applyEvent(
  event: SidebarEvent,
  setState: (updater: (prev: BackgroundState) => BackgroundState) => void,
  activeRunIdRef: { current: string | null },
): void {
  if (event.type === "state.snapshot") {
    activeRunIdRef.current = event.payload.activeRun?.runId ?? null;
    setState((prev) => ({ ...prev, ...event.payload, lastError: null }));
    return;
  }
  if (event.type === "page.attached") {
    setState((prev) => ({ ...prev, page: event.payload }));
    return;
  }
  if (event.type === "run.started") {
    activeRunIdRef.current = event.runId;
    setState((prev) => {
      const userItem: ConversationItem = {
        id: `${event.runId}-user`,
        kind: "message",
        role: "user",
        text: event.payload.prompt,
        context: event.payload.page,
        at: event.at,
      };
      return {
        ...prev,
        activeRun: { runId: event.runId as string, status: "running", partialAssistantText: "", pendingApproval: null },
        conversation: { ...prev.conversation, items: [...prev.conversation.items, userItem], updatedAt: event.at },
      };
    });
    return;
  }
  if (event.type === "assistant.delta") {
    setState((prev) =>
      prev.activeRun
        ? { ...prev, activeRun: { ...prev.activeRun, partialAssistantText: prev.activeRun.partialAssistantText + event.payload.delta } }
        : prev,
    );
    return;
  }
  if (event.type === "tool.requested") {
    setState((prev) => {
      const committed = commitPendingText(prev);
      if (!committed.activeRun) return committed;
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return { ...committed, conversation: { ...committed.conversation, items: [...committed.conversation.items, callItem] } };
    });
    return;
  }
  if (event.type === "action.approval-required") {
    setState((prev) => {
      const committed = commitPendingText(prev);
      if (!committed.activeRun) return committed;
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return {
        ...committed,
        activeRun: { ...committed.activeRun, status: "awaiting-approval", pendingApproval: event.payload },
        conversation: { ...committed.conversation, items: [...committed.conversation.items, callItem] },
      };
    });
    return;
  }
  if (event.type === "tool.result") {
    setState((prev) => {
      if (!prev.activeRun) return prev;
      const resultItem: ConversationItem = {
        id: `${event.payload.callId}-result`,
        kind: "tool-result",
        callId: event.payload.callId,
        result: event.payload.result,
        at: event.at,
      };
      const stillPending = prev.activeRun.pendingApproval?.call.id === event.payload.callId ? null : prev.activeRun.pendingApproval;
      return {
        ...prev,
        activeRun: {
          ...prev.activeRun,
          status: stillPending ? "awaiting-approval" : "running",
          pendingApproval: stillPending,
        },
        conversation: { ...prev.conversation, items: [...prev.conversation.items, resultItem] },
      };
    });
    return;
  }
  if (event.type === "run.completed") {
    activeRunIdRef.current = null;
    setState((prev) => {
      if (!prev.activeRun) return prev;
      if (!prev.activeRun.partialAssistantText) return { ...prev, activeRun: null };
      const assistantItem: ConversationItem = {
        id: event.payload.messageId,
        kind: "message",
        role: "assistant",
        text: prev.activeRun.partialAssistantText,
        at: event.at,
      };
      return {
        ...prev,
        activeRun: null,
        conversation: { ...prev.conversation, items: [...prev.conversation.items, assistantItem], updatedAt: event.at },
      };
    });
    return;
  }
  if (event.type === "run.cancelled") {
    activeRunIdRef.current = null;
    setState((prev) => {
      if (!prev.activeRun) return prev;
      if (!event.payload.messageId) return { ...prev, activeRun: null };
      const assistantItem: ConversationItem = {
        id: event.payload.messageId,
        kind: "message",
        role: "assistant",
        text: `${prev.activeRun.partialAssistantText}${RUN_CANCELLED_SUFFIX}`,
        at: event.at,
      };
      return {
        ...prev,
        activeRun: null,
        conversation: { ...prev.conversation, items: [...prev.conversation.items, assistantItem], updatedAt: event.at },
      };
    });
    return;
  }
  if (event.type === "run.failed") {
    activeRunIdRef.current = null;
    setState((prev) => ({ ...prev, activeRun: null, lastError: event.payload }));
  }
}
