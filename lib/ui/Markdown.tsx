import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** No raw HTML, remote image loads, or executable link protocols from model/page text. */
export function Markdown({ text }: { text: string }) {
  return (
    <div class="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : "")}
        components={{
          // Long tables/code scroll within the narrow sidebar. A keyboard
          // user needs a focus target to reach and scroll that content.
          table: ({ children }) => <table tabIndex={0} aria-label="Scrollable table">{children}</table>,
          pre: ({ children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>,
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => (
            <span class="markdown__image">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
