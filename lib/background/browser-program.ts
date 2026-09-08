import type { JsonValue, PageSnapshotV1, PageToolCall, ToolResult } from "@/lib/domain/tools";
import { TabController } from "./tab-controller";

export const PROGRAM_HELP = `Execute a bounded browser/filesystem program (not arbitrary JavaScript).
Use double-quoted strings, arrays/objects (including variable values), const/let declarations, await calls, and return; end statements with semicolons.
Results are printed automatically. To list both tab mounts use: return {tabs: await fs.list("/tabs"), agentTabs: await fs.list("/agent-tabs")}; JSON.stringify(value) is also supported but unnecessary.
Variables survive between programs in this run. No loops, functions, imports, selectors, property access, or network globals.
fs.list("/") lists mounts; fs.list("/tabs") and fs.list("/agent-tabs") list supported tabs with paths, URL, title, hidden state.
fs.read("/tabs/123/page.md") captures fresh markdown including revision and exact role/name targets.
Directory listings contain tab metadata, not a guarantee that Firefox exposes page content. TAB_CHANGED/NAVIGATION_INTERRUPTED means a page-access problem, not a syntax error: reuse the existing tab, retry a snapshot once if loading, then navigate that handle to a readable HTML page. Do not open duplicate tabs or change URL escaping to repair page access. fs.read(tabPath) and page.snapshot use the same reader.
fs.write("/workspace/notes.md", "text"), fs.read, fs.list, fs.move, fs.remove manage scratch files (background session only).
Tab page.md files are read-only. fs.move("/tabs/123/page.md", "/agent-tabs/123/page.md") hides a tab; reverse move shows it. fs.remove(tabPath) closes that tab.
const page = browser.tab("/tabs/123/page.md"); const research = await browser.open("https://example.com"); opens a hidden agent tab and returns a page handle.
await page.snapshot("interactive"); await page.getByRole("textbox", {name: "Email", exact: true}).fill("a@example.com");
await page.getByRole("button", {name: "Search", exact: true}).click(); return await page.snapshot("readable");
Locator methods: click(), fill(text), selectOption([values]), setChecked(boolean). For selectOption use the snapshot's option value, not its display label. Locators re-resolve uniquely against a fresh snapshot before each action.
Page methods: snapshot(mode), navigate(url), goBack(), scroll("down", "page"), path().
At most 32 statements, 64 capability calls, 16000 source characters per program. Stops on the first error; prior effects remain committed. Never replay the whole program after a partial failure.
Use the separate request_action_confirmation tool BEFORE externally visible, destructive, or paid actions; split the program before the action so the user can review it.`;

export class WorkspaceState {
  files = new Map<string, string>();
  agentTabs = new Set<number>();
}

type Expr = { type: "literal"; value: JsonValue } | { type: "variable"; name: string } |
  { type: "array"; values: Expr[] } | { type: "object"; entries: [string, Expr][] } |
  { type: "call"; receiver: Expr; method: string; args: Expr[] };
type Statement = { name?: string; returns: boolean; expression: Expr };
type Handle = { kind: "fs" } | { kind: "browser" } | { kind: "json" } | { kind: "page"; tabId: number } |
  { kind: "locator"; tabId: number; role: string; name: string };
type Value = JsonValue | Handle;
const METHODS = new Set(["list", "read", "write", "move", "remove", "tab", "open", "snapshot", "getByRole", "click", "fill", "selectOption", "setChecked", "navigate", "goBack", "scroll", "path", "stringify"]);

class ProgramError extends Error {
  constructor(message: string, readonly code: NonNullable<ToolResult["code"]>) { super(message); }
}

// Values can share subtrees across REPL variables. Bound traversal before
// serialization so repeated [value, value] cannot expand without limit.
function serialize(value: Value): string {
  let remaining = 128_000;
  const visit = (item: Value, depth: number): void => {
    remaining -= typeof item === "string" ? item.length + 2 : 8;
    if (depth > 32 || remaining < 0) throw new ProgramError("Result exceeds the size/depth limit. Return smaller results in separate programs.", "LIMIT_EXCEEDED");
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) { remaining -= key.length; visit(child, depth + 1); }
  };
  visit(value, 0);
  return JSON.stringify(value);
}

// This parser only produces capability calls and values. Source is never evaluated.
export function parseProgram(source: string): Statement[] {
  if (!source.trim() || source.length > 16_000) throw new Error("Program must contain 1–16000 characters.");
  const tokens: string[] = [];
  const pattern = /\s+|\/\/[^\n]*|"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9]\d*)(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|[().,;={}\[\]:]/y;
  let position = 0;
  while (position < source.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Unsupported syntax at character ${position}.`);
    position = pattern.lastIndex;
    if (!/^\s|^\/\//.test(match[0])) tokens.push(match[0]);
  }
  let index = 0;
  let calls = 0;
  const take = (expected: string) => { if (tokens[index++] !== expected) throw new Error(`Expected ${expected}.`); };
  const identifier = () => {
    const token = tokens[index++];
    if (!token || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) throw new Error("Expected an identifier.");
    return token;
  };
  const literal = (): JsonValue => {
    const token = tokens[index++];
    if (!token || !/^(?:"|-?\d|true$|false$|null$)/.test(token)) throw new Error("Expected a JSON literal.");
    const value: JsonValue = JSON.parse(token);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid number.");
    return value;
  };
  const expression = (depth = 0): Expr => {
    if (depth > 16) throw new Error("Expression nesting exceeds 16.");
    if (tokens[index] === "await") index++;
    let expr: Expr;
    if (tokens[index] === "[") {
      index++; const values: Expr[] = [];
      while (tokens[index] !== "]") {
        values.push(expression(depth + 1));
        if (tokens[index] !== ",") break;
        index++;
      }
      take("]"); expr = { type: "array", values };
    } else if (tokens[index] === "{") {
      index++; const entries: [string, Expr][] = [];
      while (tokens[index] !== "}") {
        const quoted = tokens[index]?.startsWith('"');
        const key = quoted ? literal() as string : identifier();
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid object key.");
        if (tokens[index] === ":") { index++; entries.push([key, expression(depth + 1)]); }
        else if (!quoted) entries.push([key, { type: "variable", name: key }]);
        else throw new Error("Expected ':' after object key.");
        if (tokens[index] !== ",") break;
        index++;
      }
      take("}"); expr = { type: "object", entries };
    } else expr = /^(?:"|-?\d|true$|false$|null$)/.test(tokens[index] ?? "")
      ? { type: "literal", value: literal() } : { type: "variable", name: identifier() };
    while (tokens[index] === ".") {
      index++;
      const method = identifier();
      if (!METHODS.has(method)) throw new Error(`Unsupported method ${method}. Results print automatically; return a value directly.`);
      if (++calls > 64) throw new Error("At most 64 calls per program.");
      take("("); const args: Expr[] = [];
      while (tokens[index] !== ")") {
        args.push(expression(depth + 1));
        if (tokens[index] !== ",") break;
        index++;
      }
      take(")"); expr = { type: "call", receiver: expr, method, args };
    }
    return expr;
  };
  const statements: Statement[] = [];
  while (index < tokens.length) {
    if (statements.length >= 32) throw new Error("At most 32 statements per program.");
    let name: string | undefined;
    if (tokens[index] === "const" || tokens[index] === "let") {
      index++; name = identifier(); take("=");
      if (["fs", "browser", "JSON", "await", "return"].includes(name)) throw new Error("Reserved variable name.");
    }
    const returns = tokens[index] === "return";
    if (returns) index++;
    statements.push({ name, returns, expression: expression() });
    if (index < tokens.length) take(";");
    if (returns && index < tokens.length) throw new Error("Return must be the last statement.");
  }
  return statements;
}

export class BrowserProgram {
  #variables = new Map<string, Value>([["fs", { kind: "fs" }], ["browser", { kind: "browser" }], ["JSON", { kind: "json" }]]);
  // Handles are capabilities minted here, never objects supplied by the program.
  #handles = new WeakSet<object>();
  constructor(private tabs: TabController, private state: WorkspaceState, private onEffect: () => void) {
    for (const value of this.#variables.values()) this.#handles.add(value as object);
  }

  async execute(source: string, signal: AbortSignal): Promise<ToolResult> {
    const output: string[] = [];
    let completed = 0;
    let parsed = false;
    try {
      const statements = parseProgram(source);
      parsed = true;
      const evaluate = async (expr: Expr): Promise<Value> => {
        signal.throwIfAborted();
        if (expr.type === "literal") return expr.value;
        if (expr.type === "array") {
          const values: Value[] = [];
          for (const child of expr.values) values.push(await evaluate(child));
          return values;
        }
        if (expr.type === "object") {
          const entries: [string, Value][] = [];
          for (const [key, child] of expr.entries) entries.push([key, await evaluate(child)]);
          return Object.fromEntries(entries);
        }
        if (expr.type === "variable") {
          if (!this.#variables.has(expr.name)) throw new Error(`Unknown variable: ${expr.name}.`);
          return this.#variables.get(expr.name)!;
        }
        const receiver = await evaluate(expr.receiver);
        if (typeof receiver !== "object" || receiver === null || !this.#handles.has(receiver)) throw new Error("Only capability handles have methods.");
        const args: Value[] = [];
        for (const arg of expr.args) args.push(await evaluate(arg));
        signal.throwIfAborted();
        return this.#call(receiver as Handle, expr.method, args, signal);
      };
      for (const statement of statements) {
        const value = await evaluate(statement.expression);
        signal.throwIfAborted();
        const rendered = typeof value === "string" ? value : serialize(value);
        if (statement.name) {
          if (!this.#variables.has(statement.name) && this.#variables.size >= 130) throw new Error("Variable limit reached; reuse an existing name.");
          this.#variables.set(statement.name, value);
        }
        completed++;
        output.push(`${completed}: ${rendered}`);
        if (output.join("\n").length > 48_000) {
          output.splice(0, output.length, output.join("\n").slice(-48_000));
        }
      }
      return { ok: true, summary: output.join("\n") || "Program completed." };
    } catch (error) {
      const diagnostic = `${parsed ? `${completed} statements completed. Stopped in statement ${completed + 1}; earlier effects may have committed. Do not replay completed steps.` : "Program rejected before execution; no statements ran."} ${error instanceof Error ? error.message.slice(0, 1400) : "Browser operation failed."}`;
      return { ok: false, code: signal.aborted ? "ACTION_DENIED" : error instanceof ProgramError ? error.code : "INVALID_TOOL_ARGUMENTS",
        summary: `${diagnostic}\n${output.join("\n").slice(-48_000)}`, data: { diagnostic } };
    }
  }

  #handle<T extends Handle>(handle: T): T { this.#handles.add(handle); return handle; }

  async #call(receiver: Handle, method: string, args: Value[], signal: AbortSignal): Promise<Value> {
    const text = (i: number) => {
      if (typeof args[i] !== "string") throw new Error("Expected a string argument.");
      return args[i] as string;
    };
    const count = (n: number) => { if (args.length !== n) throw new Error(`Expected ${n} arguments for ${method}.`); };
    if (receiver.kind === "json") {
      count(1);
      if (method !== "stringify") throw new Error("Only JSON.stringify(value) is supported.");
      return serialize(args[0]!);
    }
    if (receiver.kind === "fs") return this.#file(method, args, signal);
    if (receiver.kind === "browser") {
      count(1);
      if (method === "tab") return this.#handle({ kind: "page", tabId: await this.#tabPath(text(0)) });
      if (method === "open") {
        this.onEffect();
        const tabId = await this.tabs.createTab(text(0));
        this.state.agentTabs.add(tabId);
        // Finish hiding a newly created tab even if cancelled during creation.
        try { await this.tabs.hideTab(tabId); }
        catch { throw new Error(`Created /agent-tabs/${tabId}/page.md but Firefox could not hide it. The tab remains visible.`); }
        try { await this.tabs.waitUntilReady(tabId, signal); }
        catch { throw this.#pageError({ code: "NAVIGATION_INTERRUPTED", message: "The new tab was created but its content reader is unavailable." }, tabId); }
        return this.#handle({ kind: "page", tabId });
      }
      throw new Error("Unknown browser method.");
    }
    const controller = await this.tabs.forTab(receiver.tabId);
    signal.throwIfAborted();
    if (receiver.kind === "page" && method === "path") { count(0); return this.#path(receiver.tabId); }
    if (receiver.kind === "page" && method === "getByRole") {
      count(2);
      const options = args[1];
      if (!options || typeof options !== "object" || Array.isArray(options) || !("name" in options) || !("exact" in options) ||
          typeof options.name !== "string" || options.exact !== true || Object.keys(options).length !== 2) throw new Error("Use {name: string, exact: true}.");
      return this.#handle({ kind: "locator", tabId: receiver.tabId, role: text(0), name: options.name });
    }
    if (receiver.kind === "page" && method === "snapshot") {
      count(1); if (text(0) !== "interactive" && text(0) !== "readable") throw new Error("Invalid snapshot mode.");
      const snapshot = await controller.snapshot(text(0) as "interactive" | "readable");
      if (!snapshot.ok) throw this.#pageError(snapshot.error, receiver.tabId);
      return markdown(snapshot.value);
    }
    let name: PageToolCall["name"];
    let arguments_: JsonValue;
    if (receiver.kind === "locator") {
      const snapshot = await controller.snapshot("interactive", { role: receiver.role, name: receiver.name });
      if (!snapshot.ok) throw this.#pageError(snapshot.error, receiver.tabId);
      if (snapshot.value.truncated.nodes) throw new ProgramError("Locator scan reached its safety limit or found too many matches; use a more specific exact name.", "LIMIT_EXCEEDED");
      const matches = snapshot.value.nodes.filter((node) => node.role === receiver.role && node.name === receiver.name);
      if (matches.length !== 1) throw new ProgramError(`Locator matched ${matches.length} elements; expected exactly one. Read a fresh snapshot.`, "TARGET_MISSING");
      const base = { ref: matches[0]!.ref, revision: snapshot.value.revision };
      if (method === "click") { count(0); name = "page_click"; arguments_ = base; }
      else if (method === "fill") { count(1); name = "page_fill"; arguments_ = { ...base, text: text(0) }; }
      else if (method === "selectOption") { count(1); name = "page_select_option"; arguments_ = { ...base, values: args[0] as JsonValue }; }
      else if (method === "setChecked") { count(1); name = "page_set_checked"; arguments_ = { ...base, checked: args[0] as JsonValue }; }
      else throw new Error("Unknown locator method.");
    } else if (method === "navigate") { count(1); name = "page_navigate"; arguments_ = { url: text(0) }; }
    else if (method === "goBack") { count(0); name = "page_go_back"; arguments_ = {}; }
    else if (method === "scroll") {
      count(2); const snapshot = await controller.snapshot("interactive");
      if (!snapshot.ok) throw this.#pageError(snapshot.error, receiver.tabId);
      name = "page_scroll"; arguments_ = { ref: null, revision: snapshot.value.revision, direction: text(0), amount: text(1) };
    } else throw new Error("Unknown page method.");
    signal.throwIfAborted();
    // A lost response can follow a committed click/navigation; disable automatic retry before dispatch.
    if (name !== "page_scroll") this.onEffect();
    const outcome = await controller.execute({ id: crypto.randomUUID(), name, arguments: arguments_ });
    if (!outcome.result.ok) throw this.#pageError({ code: outcome.result.code ?? "TAB_CHANGED", message: outcome.result.summary }, receiver.tabId);
    return outcome.result.summary;
  }

  #path(tabId: number): string { return `/${this.state.agentTabs.has(tabId) ? "agent-tabs" : "tabs"}/${tabId}/page.md`; }

  #pageError(error: { code: string; message: string }, tabId: number): ProgramError {
    const codes: readonly NonNullable<ToolResult["code"]>[] = ["UNSUPPORTED_PAGE", "TAB_CHANGED", "STALE_SNAPSHOT", "TARGET_MISSING", "NOT_INTERACTABLE", "NAVIGATION_INTERRUPTED", "INVALID_TOOL_ARGUMENTS", "LIMIT_EXCEEDED", "ACTION_DENIED"];
    const code = codes.find((code) => code === error.code) ?? "TAB_CHANGED";
    const inaccessible = ["UNSUPPORTED_PAGE", "TAB_CHANGED", "NAVIGATION_INTERRUPTED"].includes(code);
    return new ProgramError(`${this.#path(tabId)}: ${error.message}${inaccessible ? " Listing a tab does not mean its content is readable. It may be loading or a browser-controlled viewer. fs.read and page.snapshot use the same reader. Do not open a duplicate or change URL escaping. List tabs to confirm the path, retry a snapshot once if loading, or navigate the existing page handle to a readable HTML page." : ""}`, code);
  }

  async #tabPath(path: string): Promise<number> {
    const match = /^\/(tabs|agent-tabs)\/([1-9]\d*)\/page\.md$/.exec(path);
    if (!match) throw new Error("Expected /tabs/<id>/page.md or /agent-tabs/<id>/page.md.");
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || !(await this.tabs.listTabs()).some((tab) => tab.id === id)) throw new ProgramError("Tab path is closed or unsupported; list tabs again.", "TARGET_MISSING");
    if (path !== this.#path(id)) throw new ProgramError(`Tab moved; use ${this.#path(id)}.`, "TARGET_MISSING");
    return id;
  }

  async #file(method: string, args: Value[], signal: AbortSignal): Promise<Value> {
    if (!args.every((arg) => typeof arg === "string")) throw new Error("Filesystem arguments must be strings.");
    const [path, destination] = args as string[];
    if (!path || args.length !== (["write", "move"].includes(method) ? 2 : 1)) throw new Error("Invalid filesystem arguments.");
    if (method === "list") {
      if (path === "/") return ["/tabs", "/agent-tabs", "/workspace"];
      if (path === "/tabs" || path === "/agent-tabs") {
        const tabs = (await this.tabs.listTabs()).filter((tab) => this.state.agentTabs.has(tab.id!) === (path === "/agent-tabs"));
        return { entries: tabs.slice(0, 200).map((tab) => ({ path: this.#path(tab.id!), url: tab.url!, title: tab.title ?? "", hidden: tab.hidden ?? false })), truncated: tabs.length > 200 };
      }
      if (path === "/workspace" || path.startsWith("/workspace/")) return [...this.state.files.keys()].filter((key) => key.startsWith(`${path.replace(/\/$/, "")}/`));
      throw new Error("Unknown directory.");
    }
    if (path.startsWith("/workspace/")) {
      const valid = (p: string) => p.length <= 256 && /^\/workspace\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p);
      if (!valid(path)) throw new Error("Invalid workspace path.");
      if (method === "write") {
        if (destination!.length > 32_000 || (!this.state.files.has(path) && this.state.files.size >= 64)) throw new Error("Workspace limit: 64 files, 32000 characters per file.");
        this.state.files.set(path, destination!); return `Wrote ${path}.`;
      }
      const content = this.state.files.get(path);
      if (content === undefined) throw new Error("File does not exist.");
      if (method === "read") return content;
      if (method === "remove") { this.state.files.delete(path); return `Removed ${path}.`; }
      if (method === "move") {
        if (!valid(destination!) || this.state.files.has(destination!)) throw new Error("Destination must be a new workspace path.");
        this.state.files.set(destination!, content); this.state.files.delete(path); return `Moved to ${destination}.`;
      }
    } else {
      const id = await this.#tabPath(path);
      signal.throwIfAborted();
      if (method === "read") {
        const snapshot = await (await this.tabs.forTab(id)).snapshot("interactive");
        if (!snapshot.ok) throw this.#pageError(snapshot.error, id);
        return markdown(snapshot.value);
      }
      if (method === "remove") {
        this.onEffect(); await this.tabs.closeTab(id); this.state.agentTabs.delete(id); return `Closed ${path}.`;
      }
      if (method === "move") {
        const toAgent = !this.state.agentTabs.has(id);
        if (destination !== `/${toAgent ? "agent-tabs" : "tabs"}/${id}/page.md`) throw new Error("Tab moves must preserve the ID and switch /tabs and /agent-tabs.");
        this.onEffect();
        if (toAgent) { await this.tabs.hideTab(id); this.state.agentTabs.add(id); }
        else { await this.tabs.showTab(id); this.state.agentTabs.delete(id); }
        return `Moved to ${destination}.`;
      }
    }
    throw new Error("Unsupported filesystem operation. Tab snapshots are read-only.");
  }
}

export function markdown(snapshot: PageSnapshotV1): string {
  const text = [`# ${snapshot.title}`, `URL: ${snapshot.url}`, `Tab: ${snapshot.tabId}`, `Revision: ${snapshot.revision}`,
    "BEGIN_UNTRUSTED_PAGE", "## Interactive elements",
    ...snapshot.nodes.map((node) => JSON.stringify({ ref: node.ref, role: node.role, name: node.name, href: node.href, value: node.value, options: node.options, optionsTruncated: node.optionsTruncated, state: node.state })),
    `Truncated: ${JSON.stringify(snapshot.truncated)}`, ...snapshot.warnings, "## Page text", snapshot.readableText].join("\n");
  return `${text.slice(0, 39_800)}${text.length > 39_800 ? "\n[Snapshot output truncated]" : ""}\nEND_UNTRUSTED_PAGE`;
}
