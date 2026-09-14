import { useEffect, useRef, useState } from "preact/hooks";

export const isAtBottom = (
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) => element.scrollHeight - element.scrollTop - element.clientHeight <= 32;

export function useBottomScroll() {
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const scrollToBottom = () => {
    following.current = true;
    setAtBottom(true);
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element || !content.current) return;
    const onScroll = () => {
      following.current = isAtBottom(element);
      setAtBottom(following.current);
    };
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content.current);
    observer.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, []);
  return { viewport, content, atBottom, scrollToBottom };
}
