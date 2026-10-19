import type { ComponentChildren } from "preact";
import ChevronRight from "~icons/tabler/chevron-right";

/** Unset means done. The title must also state the status in words. */
export type TraceStatus = "running" | "error" | "pending";

/** A list of one-line work rows, modelled on shadcn's Trace. */
export function Trace(props: { label?: string; children: ComponentChildren }) {
  return (
    <ul class="trace" aria-label={props.label}>
      {props.children}
    </ul>
  );
}

/**
 * One row: icon, truncating title, optional non-shrinking description. With
 * children it becomes a native disclosure whose content is indented behind a
 * rule. `open` is applied only when it changes, so user toggles survive
 * re-renders.
 */
export function TraceLine(props: {
  icon: ComponentChildren;
  title: string;
  description?: string;
  status?: TraceStatus;
  open?: boolean;
  children?: ComponentChildren;
}) {
  const row = (
    <>
      <span class="trace__icon" aria-hidden="true">
        {props.icon}
      </span>
      <span class="trace__title">{props.title}</span>
      {props.description && (
        <span class="trace__description">{props.description}</span>
      )}
    </>
  );
  return (
    <li class="trace__item" data-status={props.status}>
      {props.children ? (
        <details class="trace__collapsible" open={props.open}>
          <summary class="trace__line">
            {row}
            <ChevronRight class="trace__chevron" aria-hidden="true" />
          </summary>
          <div class="trace__content">{props.children}</div>
        </details>
      ) : (
        <div class="trace__line">{row}</div>
      )}
    </li>
  );
}
