import katex from "katex";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { WorkspaceImageLoad } from "@/lib/ui/use-background";
import { normalizeMathDelimiters } from "@/lib/ui/markdown-math";
import { isViewableImagePath, isWorkspacePath } from "@/lib/validation";

/** Where an answer's `/workspace` images come from: the session it belongs to. Without it images stay placeholders. */
export interface MarkdownImages {
  sessionId: string;
  load(sessionId: string, path: string): Promise<WorkspaceImageLoad>;
}

/**
 * No raw HTML, remote image loads, or executable link protocols from model/page text.
 * Math renders as MathML (no KaTeX HTML, CSS, or fonts; `trust` off, so no links or
 * images from TeX). Images render only from the session's own `/workspace`.
 */
export function Markdown({ text, images }: { text: string; images?: MarkdownImages }) {
  // Component types must keep their identity across renders: a new function is a
  // new type to Preact, which remounts every image and equation, collapsing the
  // transcript's height for a frame and throwing the scroll position.
  const components = useMemo<Components>(() => ({
    ...STATIC_COMPONENTS,
    img: ({ src, alt }) =>
      typeof src === "string" && src && images ? (
        <WorkspaceImage path={src} alt={typeof alt === "string" ? alt : ""} images={images} />
      ) : (
        <span class="markdown__image">{alt ? `[Image: ${alt}]` : "[Image]"}</span>
      ),
  }), [images]);
  return (
    <div class="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml urlTransform={urlTransform} components={components}>
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </div>
  );
}

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];

const urlTransform: Options["urlTransform"] = (url, key) =>
  key === "src" ? workspaceImagePath(url) ?? "" : /^(https?:\/\/|mailto:)/i.test(url) ? url : "";

const STATIC_COMPONENTS: Components = {
  // Long tables/code scroll within the narrow sidebar. A keyboard
  // user needs a focus target to reach and scroll that content.
  table: ({ children }) => <table tabIndex={0} aria-label="Scrollable table">{children}</table>,
  pre: ({ node, children }) => {
    const code = node?.children[0];
    return code?.type === "element" && isMathCode(code.properties.className)
      ? <>{children}</>
      : <pre tabIndex={0} aria-label="Code block">{children}</pre>;
  },
  code: ({ node, className, children }) => {
    if (!isMathCode(node?.properties.className)) return <code class={className}>{children}</code>;
    const display = !String(node?.properties.className).includes("math-inline");
    return <TeX tex={String(children ?? "")} display={display} />;
  },
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

/**
 * The `/workspace` image a Markdown image URL names: `/workspace/a.png`, or the
 * `sandbox:/workspace/a.png` and `workspace:a.png` forms models also write.
 * Anything else (remote URLs, PDFs, text files) is null.
 */
export function workspaceImagePath(url: string): string | null {
  let path = url.trim().replace(/^sandbox:/i, "");
  if (/^workspace:/i.test(path)) {
    path = path.replace(/^workspace:\/*/i, "/");
    if (!path.startsWith("/workspace/")) path = `/workspace${path}`;
  }
  return isWorkspacePath(path) && isViewableImagePath(path) ? path : null;
}

const isMathCode = (className: unknown) =>
  Array.isArray(className) && className.some((name) => name === "language-math" || name === "math-inline" || name === "math-display");

const KATEX_OPTIONS = { output: "mathml", throwOnError: false, trust: false, strict: "ignore", maxSize: 20, maxExpand: 500 } as const;

/** KaTeX builds the MathML with DOM calls (no HTML parsing); a block scrolls sideways like a table. */
function TeX({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    try {
      katex.render(tex, element, { ...KATEX_OPTIONS, displayMode: display });
    } catch {
      element.textContent = tex;
    }
  }, [tex, display]);
  return display
    ? <div ref={ref as preact.Ref<HTMLDivElement>} class="markdown__math" tabIndex={0} aria-label="Math" />
    : <span ref={ref as preact.Ref<HTMLSpanElement>} class="markdown__math-inline" />;
}

function WorkspaceImage({ path, alt, images }: { path: string; alt: string; images: MarkdownImages }) {
  const [loaded, setLoaded] = useState<WorkspaceImageLoad | null>(null);
  const { sessionId, load } = images;
  useEffect(() => {
    let live = true;
    setLoaded(null);
    void load(sessionId, path).then((reply) => { if (live) setLoaded(reply); });
    return () => { live = false; };
  }, [sessionId, load, path]);
  const label = alt ? `Image: ${alt}` : "Image";
  if (!loaded) return <span class="markdown__image">[{label} — loading]</span>;
  if (!loaded.ok) {
    return <span class="markdown__image">[{label} — {path} {loaded.reason === "unavailable" ? "could not be loaded" : "no longer exists"}]</span>;
  }
  return <img class="markdown__picture" src={`data:${loaded.mimeType};base64,${loaded.data}`} alt={alt} title={path} />;
}
