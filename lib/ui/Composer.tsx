import { MCP_CONTENT_LIMITS, type McpContentChoice, type McpContentSnapshot } from "@/lib/domain/mcp-content";
import { McpContentChip } from "@/lib/ui/McpContentChip";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createEditor,
  Editor,
  Element,
  Node,
  Range,
  Transforms,
  type BaseEditor,
  type Descendant,
} from "slate";
import { Editable, ReactEditor, Slate, withReact } from "slate-react";
import { withHistory } from "slate-history";
import type { TabMention } from "@/lib/protocol";
import type { SkillSummary } from "@/lib/domain/skills";
import { PROMPT_MENTION_PATTERN } from "@/lib/domain/conversation";
import ArrowUp from "~icons/tabler/arrow-up";
import PlayerStop from "~icons/tabler/player-stop";
import SteeringWheel from "~icons/tabler/steering-wheel";

type Mention = {
  type: "mention";
  tab: TabMention;
  children: [{ text: string }];
};
type Paragraph = {
  type: "paragraph";
  children: ({ text: string } | Mention)[];
};
declare module "slate" {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: Paragraph | Mention;
    Text: { text: string };
  }
}

export function serializeDraft(nodes: Descendant[]): string {
  const serialize = (node: Descendant): string =>
    Element.isElement(node)
      ? node.type === "mention"
        ? `@${node.tab.title || node.tab.url} (tab ${node.tab.id}, ${node.tab.path}, ${node.tab.url})`
        : node.children.map(serialize).join("")
      : Node.string(node);
  return nodes.map(serialize).join("\n").trim();
}

export type PromptSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; label: string; tabId: number; agentTab: boolean; url: string };

/** Splits a sent prompt back into text and the mentions `serializeDraft` encoded. */
export function parsePromptMentions(prompt: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let last = 0;
  for (const match of prompt.matchAll(PROMPT_MENTION_PATTERN)) {
    if (match.index > last) segments.push({ kind: "text", text: prompt.slice(last, match.index) });
    segments.push({ kind: "mention", label: match[1]!, tabId: Number(match[2]), agentTab: match[3] === "agent-tabs", url: match[4]! });
    last = match.index + match[0].length;
  }
  if (last < prompt.length) segments.push({ kind: "text", text: prompt.slice(last) });
  return segments;
}

/**
 * What a key press in the editor does. Enter sends (while this chat's run is
 * working, that queues a follow-up); Ctrl/Cmd+Enter steers when steering is
 * available. Shift+Enter is a newline.
 */
export function composerKeyAction(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  canSteer: boolean,
): "send" | "steer" | null {
  if (event.key !== "Enter" || event.shiftKey) return null;
  return canSteer && (event.ctrlKey || event.metaKey) ? "steer" : "send";
}

export function Composer(props: {
  sessionId?: string;
  attachments?: McpContentSnapshot[];
  onListMcpContent?: (kind: "prompt" | "resource") => Promise<{ choices: McpContentChoice[]; errors: { message: string }[] }>;
  onPrepareMcpContent?: (id: string, args: Record<string, string>) => Promise<void>;
  onDismissMcpContent?: (id: string) => void;
  disabled: boolean;
  /** This chat's run is active: Stop is shown. */
  running: boolean;
  /** This chat's run is working: sending queues a follow-up. */
  working: boolean;
  /** This chat's run can take a steer (it is not stopping). */
  canSteer: boolean;
  configured: boolean;
  tabs: TabMention[];
  skills?: SkillSummary[];
  focusVersion?: number;
  /** A deliberate quick-action choice; inserts editable text and never sends it. */
  draft?: { id: string; text: string } | null;
  askId?: string;
  placeholder?: string;
  onListSkills?: () => void;
  onListTabs: () => void;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
}) {
  const editor = useMemo(() => {
    const editor = withReact(withHistory(createEditor()));
    const { isInline, isVoid } = editor;
    editor.isInline = (node) => node.type === "mention" || isInline(node);
    editor.isVoid = (node) => node.type === "mention" || isVoid(node);
    // Pasted rich text/Slate fragments are untrusted; accept plain text only.
    editor.insertData = (data) => editor.insertText(data.getData("text/plain"));
    return editor;
  }, []);
  const [target, setTarget] = useState<Range | null>(null);
  const [search, setSearch] = useState("");
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [skillMode, setSkillMode] = useState(false);
  const [remoteChoices, setRemoteChoices] = useState<McpContentChoice[]>([]);
  const [remoteError, setRemoteError] = useState("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<Extract<McpContentChoice, { kind: "prompt" }> | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const discoveryVersion = useRef(0);
  const currentSession = useRef(props.sessionId);
  currentSession.current = props.sessionId;
  useEffect(() => {
    discoveryVersion.current++;
    setRemoteChoices([]); setSelectedPrompt(null); setRemoteError(""); setLoadingContent(false); setPreparing(false); setTarget(null);
  }, [props.sessionId]);
  const discover = (kind: "prompt" | "resource") => {
    const version = ++discoveryVersion.current;
    setRemoteChoices([]); setRemoteError("");
    if (!props.onListMcpContent) return;
    setLoadingContent(true);
    void props.onListMcpContent(kind).then(result => {
      if (version !== discoveryVersion.current) return;
      setRemoteChoices(result.choices);
      setRemoteError(result.errors.map(error => error.message).join(" "));
    }).catch(error => { if (version === discoveryVersion.current) setRemoteError(error instanceof Error ? error.message : "Could not list connected-account content."); })
      .finally(() => { if (version === discoveryVersion.current) setLoadingContent(false); });
  };
  const prepare = async (choice: McpContentChoice, arguments_: Record<string, string>) => {
    if (!props.onPrepareMcpContent || preparing) return;
    const sessionId = props.sessionId;
    setPreparing(true); setRemoteError("");
    try {
      await props.onPrepareMcpContent(choice.id, arguments_);
      if (currentSession.current !== sessionId) return;
      if (choice.kind === "prompt") {
        Transforms.insertText(editor, `/${choice.command} `);
        setSelectedPrompt(null);
      }
      ReactEditor.focus(editor);
    } catch (error) { if (currentSession.current === sessionId) setRemoteError(error instanceof Error ? error.message : "Could not prepare MCP content."); }
    finally { if (currentSession.current === sessionId) setPreparing(false); }
  };
  const seenDraft = useRef<string | null>(null);
  useEffect(() => {
    const focus = () => {
      if (props.disabled) return;
      ReactEditor.focus(editor);
      if (!editor.selection) Transforms.select(editor, Editor.end(editor, []));
    };
    // Opening the native sidebar (including Firefox's special command) mounts/focuses this window.
    const timer = requestAnimationFrame(focus);
    window.addEventListener("focus", focus);
    return () => { cancelAnimationFrame(timer); window.removeEventListener("focus", focus); };
  }, [editor, props.disabled, props.focusVersion, props.askId]);
  useEffect(() => {
    if (!props.draft || props.draft.id === seenDraft.current) return;
    seenDraft.current = props.draft.id;
    // Preserve an existing draft; quick actions remain visible only in an empty chat.
    if (serializeDraft(editor.children)) return;
    Transforms.select(editor, Editor.range(editor, []));
    Transforms.insertText(editor, props.draft.text);
    setTarget(null);
    ReactEditor.focus(editor);
  }, [editor, props.draft]);
  const skillMatches = (props.skills ?? []).filter((skill) => skill.name.startsWith(search.toLowerCase())).slice(0, 8);
  const matches = props.tabs
    .filter((tab) =>
      `${tab.title} ${tab.url}`.toLowerCase().includes(search.toLowerCase()),
    )
    .slice(0, 8);
  const remoteMatches = remoteChoices.filter(choice => choice.kind === (skillMode ? "prompt" : "resource") &&
    `${choice.command} ${choice.name} ${choice.server}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8);
  type Option = { kind: "skill"; skill: SkillSummary } | { kind: "tab"; tab: TabMention } | { kind: "remote"; choice: McpContentChoice };
  const options: Option[] = [...(skillMode ? skillMatches.map(skill => ({ kind: "skill" as const, skill })) : matches.map(tab => ({ kind: "tab" as const, tab }))), ...remoteMatches.map(choice => ({ kind: "remote" as const, choice }))];
  const matchCount = options.length;
  const selectOption = (option: Option) => {
    if (!target) return;
    if (option.kind === "tab") return mention(option.tab);
    Transforms.select(editor, target);
    if (option.kind === "skill") Transforms.insertText(editor, `/${option.skill.name} `);
    else {
      Transforms.delete(editor);
      if (option.choice.kind === "prompt") { setArgs({}); setSelectedPrompt(option.choice); }
      else void prepare(option.choice, {});
    }
    setTarget(null);
    if (option.kind === "skill") ReactEditor.focus(editor);
  };
  const selectMatch = () => { if (options[index]) selectOption(options[index]!); };
  const send = (steer = false) => {
    const value = serializeDraft(editor.children);
    if (!value || value.length > 16000 || props.disabled || preparing || selectedPrompt) return;
    if (steer) props.onSteer(value);
    else props.onSend(value);
    Transforms.select(editor, Editor.range(editor, []));
    Transforms.delete(editor);
    setTarget(null);
  };
  const mention = (tab: TabMention) => {
    if (!target) return;
    Transforms.select(editor, target);
    Transforms.insertNodes(editor, {
      type: "mention",
      tab,
      children: [{ text: "" }],
    });
    Transforms.move(editor);
    Transforms.insertText(editor, " ");
    setTarget(null);
    ReactEditor.focus(editor);
  };
  return (
    <Slate
      editor={editor}
      initialValue={[{ type: "paragraph", children: [{ text: "" }] }]}
      onChange={() => {
        setText(serializeDraft(editor.children));
        const selection = editor.selection;
        if (selection && Range.isCollapsed(selection)) {
          const start = Editor.start(editor, selection.anchor.path);
          const before = Editor.string(editor, {
            anchor: start,
            focus: selection.anchor,
          });
          const skillMatch = /^\/([^\s]*)$/.exec(before);
          const atStart = Editor.isStart(editor, start, []);
          const isSkill = !!skillMatch && atStart;
          const match = isSkill
            ? skillMatch
            : /(?:^|\s)@([^@\n]*)$/.exec(before);
          if (match) {
            const anchor = {
              ...selection.anchor,
              offset: selection.anchor.offset - match[1]!.length - 1,
            };
            if (!target || skillMode !== isSkill) {
              discover(isSkill ? "prompt" : "resource");
              if (isSkill) props.onListSkills?.();
              else props.onListTabs();
            }
            setSkillMode(isSkill);
            setTarget({ anchor, focus: selection.anchor });
            setSearch(match[1]!);
            setIndex(0);
            return;
          }
        }
        setTarget(null);
      }}
    >
      {(props.attachments ?? []).map((item) => (
        <McpContentChip
          key={item.id}
          item={item}
          onRemove={() => props.onDismissMcpContent?.(item.id)}
        />
      ))}
      {selectedPrompt && (
        <form
          class="mcp-prompt-form"
          aria-label={`Prepare ${selectedPrompt.server} prompt`}
          onSubmit={(event) => {
            event.preventDefault();
            void prepare(selectedPrompt, args);
          }}
        >
          <strong>
            {selectedPrompt.server} · /{selectedPrompt.command}
          </strong>
          <p>{selectedPrompt.description}</p>
          <small>
            Arguments are sent to this connected account. Do not enter
            passwords, tokens, or verification codes.
          </small>
          {selectedPrompt.arguments.map((arg, i) => (
            <label key={arg.name}>
              {arg.name} ({arg.required ? "required" : "optional"})
              <small id={`mcp-arg-help-${i}`}>{arg.description}</small>
              <input
                autoFocus={i === 0}
                name={arg.name}
                required={arg.required}
                maxLength={MCP_CONTENT_LIMITS.argumentChars}
                aria-describedby={`mcp-arg-help-${i}`}
                value={args[arg.name] ?? ""}
                onInput={(event) =>
                  setArgs({ ...args, [arg.name]: event.currentTarget.value })
                }
                disabled={preparing}
              />
            </label>
          ))}
          <button
            type="submit"
            autoFocus={selectedPrompt.arguments.length === 0}
            disabled={
              preparing ||
              (props.attachments?.length ?? 0) >= MCP_CONTENT_LIMITS.attachments
            }
          >
            {preparing ? "Preparing…" : "Prepare preview"}
          </button>
          <button
            type="button"
            disabled={preparing}
            onClick={() => {
              setSelectedPrompt(null);
              ReactEditor.focus(editor);
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {remoteError && (
        <p role="alert" class="sidebar__error">
          {remoteError}
        </p>
      )}
      {preparing && !selectedPrompt && (
        <p role="status">Preparing resource preview…</p>
      )}
      <div class="composer__editor-row">
        <Editable
          className="composer__editor"
          aria-label="Message"
          readOnly={props.disabled}
          role="textbox"
          aria-multiline="true"
          aria-autocomplete="list"
          aria-expanded={!!target}
          aria-controls={target ? "tab-suggestions" : undefined}
          aria-activedescendant={
            target && matchCount > index
              ? `composer-option-${index}`
              : undefined
          }
          placeholder={
            !props.configured
              ? "Connect OpenAI in settings to start."
              : props.working
                ? "Enter queues, Ctrl/⌘+Enter steers…"
                : (props.placeholder ??
                  "Type a task, / for prompts or skills, @ for resources or tabs…")
          }
          renderElement={({ attributes, children, element }) =>
            element.type === "mention" ? (
              <span
                {...attributes}
                className="tab-mention"
                contentEditable={false}
                title={element.tab.url}
              >
                {children}@{element.tab.title || element.tab.url}
              </span>
            ) : (
              <div {...attributes}>{children}</div>
            )
          }
          onKeyDown={(event) => {
            if (event.isComposing) return;
            if (target) {
              if (event.key === "Escape") {
                event.preventDefault();
                setTarget(null);
                return;
              }
              if (
                matchCount &&
                ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)
              ) {
                event.preventDefault();
                if (event.key === "ArrowDown")
                  setIndex((index + 1) % matchCount);
                else if (event.key === "ArrowUp")
                  setIndex((index + matchCount - 1) % matchCount);
                else selectMatch();
                return;
              }
            }
            const action = composerKeyAction(
              event,
              props.working && props.canSteer,
            );
            if (action) {
              event.preventDefault();
              send(action === "steer");
            }
          }}
        />
        {props.working && text && text.length <= 16000 && (
          <>
            {props.canSteer && (
              <button
                class="composer__send composer__send--secondary"
                type="button"
                aria-label="Steer"
                title="Steer: send now as guidance at the next step (Ctrl/⌘+Enter)"
                disabled={props.disabled}
                onClick={() => send(true)}
              >
                <SteeringWheel />
              </button>
            )}
            <button
              class="composer__send composer__send--secondary"
              type="button"
              aria-label="Queue message"
              title="Queue: send after this task finishes (Enter)"
              disabled={props.disabled}
              onClick={() => send()}
            >
              <ArrowUp />
            </button>
          </>
        )}
        {props.running ? (
          <button
            class="composer__send"
            type="button"
            aria-label="Stop response"
            title="Stop response"
            onClick={props.onStop}
          >
            <PlayerStop />
          </button>
        ) : (
          <button
            class="composer__send"
            type="button"
            aria-label="Send message"
            title="Send message"
            disabled={
              props.disabled ||
              preparing ||
              !!selectedPrompt ||
              !text ||
              text.length > 16000
            }
            onClick={() => send()}
          >
            <ArrowUp />
          </button>
        )}
      </div>
      {text.length > 16000 && (
        <p class="sidebar__error">
          Message is too long (maximum 16,000 characters).
        </p>
      )}
      {target && (
        <div
          class="tab-suggestions"
          id="tab-suggestions"
          role="listbox"
          aria-label={
            skillMode
              ? "Skills and connected-account prompts"
              : "Tabs and connected-account resources"
          }
        >
          <div class="tab-suggestions__heading">
            {skillMode ? "Skills and MCP prompts" : "Tabs and MCP resources"}
          </div>
          {options.map((option, i) => (
            <div
              key={i}
              role="option"
              id={`composer-option-${i}`}
              aria-selected={index === i}
              class="tab-suggestions__option"
              onMouseDown={(event) => {
                event.preventDefault();
                selectOption(option);
              }}
            >
              {option.kind === "skill" ? (
                <>
                  <strong>/{option.skill.name}</strong>
                  <small>Saved skill · {option.skill.description}</small>
                </>
              ) : option.kind === "tab" ? (
                <>
                  <strong>{option.tab.title || option.tab.url}</strong>
                  <small>Tab · {option.tab.url}</small>
                </>
              ) : (
                <>
                  <strong>
                    {skillMode
                      ? `/${option.choice.command}`
                      : option.choice.name}
                  </strong>
                  <small>
                    {option.choice.server} · MCP {option.choice.kind} ·{" "}
                    {option.choice.description}
                  </small>
                </>
              )}
            </div>
          ))}
          {loadingContent && (
            <p role="status">Loading connected-account content…</p>
          )}
          {!options.length && !loadingContent && (
            <p>
              No matching{" "}
              {skillMode ? "skills or prompts" : "tabs or resources"}.
            </p>
          )}
        </div>
      )}
    </Slate>
  );
}
