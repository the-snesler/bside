import X from "~icons/tabler/x";
import { describeAsk, type AskContextV1 } from "@/lib/domain/ask";

export function AskChip({ ask, onRemove }: { ask: AskContextV1; onRemove?: () => void }) {
  const description = describeAsk(ask);
  return (
    <div class="ask-chip" title={`${ask.pageTitle || ask.pageUrl}\n${description.text}`}>
      <div class="ask-chip__heading"><strong>{description.label}</strong><small>Page context · untrusted</small>
        {onRemove && <button type="button" class="icon-button" aria-label="Remove page context" onClick={onRemove}><X /></button>}
      </div>
      <p>{description.text}</p>
      {ask.truncated && <small>Selection shortened to 4,000 characters</small>}
    </div>
  );
}
