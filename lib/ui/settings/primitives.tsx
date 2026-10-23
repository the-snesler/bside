import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import AlertTriangle from "~icons/tabler/alert-triangle";
import InfoCircle from "~icons/tabler/info-circle";
import Selector from "~icons/tabler/selector";

/**
 * Building blocks for settings pages: small muted section labels over
 * rounded cards, each a list of rows (title and one-line description on the
 * left, the control on the right) split by hairlines. Pages compose these
 * instead of styling their own layout, so every page reads the same.
 */

/** A group of cards under an optional small muted label. */
export function SettingsSection(props: { label?: string; children: ComponentChildren }) {
  const id = useId();
  return (
    <section class="settings-section" aria-labelledby={props.label ? id : undefined}>
      {props.label && <h2 id={id} class="settings-section__label">{props.label}</h2>}
      {props.children}
    </section>
  );
}

export function Card(props: { children: ComponentChildren; label?: string }) {
  return <div class="settings-card" role={props.label ? "group" : undefined} aria-label={props.label}>{props.children}</div>;
}

/**
 * One setting. With `controlId`, the title is the `<label>` of the control
 * that has that id. `children` render under the row's text at full width,
 * for inline forms and confirmations.
 */
export function Row(props: {
  title: ComponentChildren;
  description?: ComponentChildren;
  /** Announce description changes (connection state, counts) to assistive technology. */
  live?: boolean;
  controlId?: string;
  control?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const Title = props.controlId ? "label" : "span";
  return (
    <div class="settings-row">
      <div class="settings-row__main">
        <div class="settings-row__text">
          <Title class="settings-row__title" for={props.controlId}>{props.title}</Title>
          {props.description !== undefined && (
            <span
              class="settings-row__description"
              id={props.controlId ? `${props.controlId}-description` : undefined}
              role={props.live ? "status" : undefined}
            >
              {props.description}
            </span>
          )}
        </div>
        {props.control !== undefined && <div class="settings-row__control">{props.control}</div>}
      </div>
      {props.children !== undefined && <div class="settings-row__body">{props.children}</div>}
    </div>
  );
}

/** A muted footnote under a card: where data lives, what is shared. */
export function Note(props: { children: ComponentChildren }) {
  return <p class="settings-note">{props.children}</p>;
}

/**
 * A highlighted notice above the cards. `accent` is for the one thing to do
 * next (e.g. connect an account); `warning` is for something that changed
 * under the user.
 */
export function Banner(props: { tone?: "accent" | "warning"; children: ComponentChildren; action?: ComponentChildren }) {
  const tone = props.tone ?? "accent";
  const Icon = tone === "warning" ? AlertTriangle : InfoCircle;
  return (
    <div class={`settings-banner settings-banner--${tone}`} role="status">
      <Icon class="settings-banner__icon" aria-hidden="true" />
      <div class="settings-banner__text">{props.children}</div>
      {props.action !== undefined && <div class="settings-banner__action">{props.action}</div>}
    </div>
  );
}

/** A native select with the shared chevron. */
export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span class="settings-select">
      <select {...props} aria-describedby={props.id ? `${props.id}-description` : undefined} />
      <Selector class="settings-select__chevron" aria-hidden="true" />
    </span>
  );
}

/** An on/off setting: a real checkbox exposed as a switch. */
export function Switch(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <input
      {...props}
      type="checkbox"
      role="switch"
      class="settings-switch"
      aria-describedby={props.id ? `${props.id}-description` : undefined}
    />
  );
}

/** Feedback from the last action: `error` interrupts, anything else is polite. */
export function Feedback(props: { error?: boolean; children: ComponentChildren }) {
  return props.error
    ? <p class="settings-feedback settings-feedback--error" role="alert">{props.children}</p>
    : <p class="settings-feedback" role="status">{props.children}</p>;
}
