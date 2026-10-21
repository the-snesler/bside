import { useMemo, useState } from "preact/hooks";
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
  disabled: boolean;
  /** Any run is active: Stop is shown. */
  running: boolean;
  /** This chat's run is working: sending queues a follow-up. */
  working: boolean;
  /** This chat's run can take a steer (it is not stopping). */
  canSteer: boolean;
  configured: boolean;
  tabs: TabMention[];
  skills?: SkillSummary[];
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
  const skillMatches = (props.skills ?? []).filter((skill) => skill.name.startsWith(search.toLowerCase())).slice(0, 8);
  const matches = props.tabs
    .filter((tab) =>
      `${tab.title} ${tab.url}`.toLowerCase().includes(search.toLowerCase()),
    )
    .slice(0, 8);
  const matchCount = skillMode ? skillMatches.length : matches.length;
  const selectMatch = () => {
    if (!skillMode) return mention(matches[index]!);
    if (!target || !skillMatches[index]) return;
    Transforms.select(editor, target);
    Transforms.insertText(editor, `/${skillMatches[index]!.name} `);
    setTarget(null);
    ReactEditor.focus(editor);
  };
  const send = (steer = false) => {
    const value = serializeDraft(editor.children);
    if (!value || value.length > 16000 || props.disabled) return;
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
          const skillMatch = /^\/([a-z0-9-]*)$/.exec(before);
          const atStart = Editor.isStart(editor, start, []);
          const isSkill = !!skillMatch && atStart;
          const match = isSkill ? skillMatch : /(?:^|\s)@([^@\n]*)$/.exec(before);
          if (match) {
            const anchor = {
              ...selection.anchor,
              offset: selection.anchor.offset - match[1]!.length - 1,
            };
            if (!target || skillMode !== isSkill) {
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
              ? skillMode ? `skill-option-${skillMatches[index]!.name}` : `tab-option-${matches[index]!.id}`
              : undefined
          }
          placeholder={
            !props.configured
              ? "Connect OpenAI in settings to start."
              : props.working
                ? "Enter queues, Ctrl/⌘+Enter steers…"
                : "Ask a task, / for skills, @ for tabs…"
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
            const action = composerKeyAction(event, props.working && props.canSteer);
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
            disabled={props.disabled || !text || text.length > 16000}
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
          aria-label={skillMode ? "Saved skills" : "Open tabs"}
        >
          <div class="tab-suggestions__heading">{skillMode ? "Invoke a skill" : "Mention a tab"}</div>
          {skillMode ? skillMatches.length ? skillMatches.map((skill, i) => (
            <div key={skill.name} role="option" id={`skill-option-${skill.name}`} aria-selected={index === i} class="tab-suggestions__option"
              onMouseDown={(event) => {
                event.preventDefault();
                if (!target) return;
                Transforms.select(editor, target);
                Transforms.insertText(editor, `/${skill.name} `);
                setTarget(null);
                ReactEditor.focus(editor);
              }}>
              <strong>/{skill.name}</strong><small>{skill.description}</small>
            </div>
          )) : <p>No matching skills. Add one in Settings → Skills.</p> : matches.length ? (
            matches.map((tab, i) => (
              <div
                key={tab.id}
                role="option"
                id={`tab-option-${tab.id}`}
                aria-selected={index === i}
                class="tab-suggestions__option"
                onMouseDown={(event) => {
                  event.preventDefault();
                  mention(tab);
                }}
              >
                <strong>{tab.title || tab.url}</strong>
                <small>{tab.url}</small>
              </div>
            ))
          ) : (
            <p>No matching tabs</p>
          )}
        </div>
      )}
    </Slate>
  );
}
