/** Prompts are editable drafts. Selecting one never starts a run. */
export const QUICK_ACTIONS = [
  { name: "summarize-page", label: "Summarize this page", prompt: "/summarize-page Summarize this page." },
  { name: "extract-table", label: "Extract a table", prompt: "/extract-table Extract a table from this page." },
  { name: "fill-form", label: "Fill this form from…", prompt: "/fill-form Fill this form from… " },
] as const;
