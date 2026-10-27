// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { h, render } from "preact";
import { describeActivity, TurnTrace } from "@/lib/ui/TurnTrace";
import { buildTurns, type Activity } from "@/lib/ui/turns";
import type { ConversationItem } from "@/lib/domain/conversation";
import type { ToolCall, ToolResult } from "@/lib/domain/tools";
import type { ApprovalRequest } from "@/lib/protocol";

const call: ToolCall = { id: "c1", name: "mcp__notion__notion-delete", arguments: { page: "<b>Plan</b>" }, mcp: { server: "notion", tool: "notion-delete", readOnly: false } };

function activity(result: ToolResult | null): Activity {
  return { kind: "activity", id: "c1", startedAt: 0, endedAt: result ? 1 : null, call, result };
}

describe("MCP calls in the sidebar trace", () => {
  it("labels a call by its server and tool, with the server's icon", () => {
    expect(describeActivity(activity(null), false)).toMatchObject({ title: "Using Notion: notion-delete", status: "running" });
    expect(describeActivity(activity({ ok: true, summary: "Completed." }), false).title).toBe("Used Notion: notion-delete");
    expect(describeActivity(activity({ ok: false, code: "CONNECTION_ERROR", summary: "Could not reach Notion." }), false)).toMatchObject({ title: "Couldn't use Notion: notion-delete", status: "error" });
    // A denial is the user's decision, not a failed step.
    expect(describeActivity(activity({ ok: false, code: "ACTION_DENIED", summary: "Denied." }), false)).toEqual(expect.objectContaining({ title: "Denied: Notion: notion-delete" }));
    expect(describeActivity(activity({ ok: false, code: "ACTION_DENIED", summary: "Denied." }), false).status).toBeUndefined();
    expect(describeActivity(activity(null), true)).toMatchObject({ title: "Waiting for approval: Notion: notion-delete", status: "pending" });
  });

  it("shows a gated call's server, tool, and arguments on the confirmation card as text", () => {
    const items: ConversationItem[] = [
      { id: "u1", kind: "message", role: "user", text: "Delete it", context: null, at: 0 },
      { id: "i1", kind: "tool-call", call, at: 1 },
    ];
    const [turn] = buildTurns(items, true);
    const approval: ApprovalRequest = { call, origin: "", display: "Notion: notion-delete", target: {},
      mcp: { server: "notion", serverName: "Notion", tool: "notion-delete", destructive: true, arguments: '{\n  "page": "<b>Plan</b>"\n}' } };
    const root = document.createElement("div");
    document.body.append(root);
    render(h(TurnTrace, { turn: turn!, active: true, pendingApproval: approval, onApprove: () => {}, onDeny: () => {} }), root);
    expect(root.textContent).toContain("bside wants to use Notion's notion-delete tool, which may change or delete data in your account:");
    expect(root.querySelector(".trace__content pre")?.textContent).toBe('{\n  "page": "<b>Plan</b>"\n}');
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("Settings › Connections");
    expect([...root.querySelectorAll(".trace__actions button")].map((button) => button.textContent)).toEqual(["Approve", "Deny"]);
    render(null, root);
  });
  it("retains visible source-labeled MCP snapshots in delivered-steer trace steps", () => {
    const content: import("@/lib/domain/mcp-content").McpContentSnapshot[] = [{ version: 1, id: "selected", sessionId: "s1", kind: "resource", serverId: "notion", server: "Notion", name: "Roadmap", uri: "internal://roadmap", text: '<img src="https://bad.invalid/track">Original steering context' }];
    const items: ConversationItem[] = [
      { id: "u", kind: "message", role: "user", text: "Start", context: null, at: 0 },
      { id: "steer", kind: "message", role: "user", text: "Use this source", context: null, delivery: "steer", content, at: 1 },
      { id: "answer", kind: "message", role: "assistant", text: "Done", at: 2 },
    ];
    const turn = buildTurns(items, false)[0]!;
    expect(turn.steps[0]).toMatchObject({ kind: "steer", content });
    const root = document.createElement("div"); document.body.append(root);
    render(h(TurnTrace, { turn, active: false, pendingApproval: null, onApprove: () => {}, onDeny: () => {} }), root);
    expect(root.querySelector(".trace__steer")?.textContent).toContain("Use this source");
    expect(root.querySelector(".trace__steer summary")?.textContent).toBe("Notion · Resource · Roadmap");
    expect(root.querySelector(".trace__steer pre")?.textContent).toBe(content[0]!.text);
    expect(root.querySelector(".trace__steer")?.textContent).toContain("internal://roadmap");
    expect(root.querySelectorAll("img,a,script")).toHaveLength(0);
    render(null, root); root.remove();
  });

});
