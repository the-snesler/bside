/**
 * Preact hook connecting a UI surface to the background's
 * "agent-sidebar:v1" Port. The sidebar renders this state; it never owns an
 * inference request, tool loop, transcript authority, or credential read.
 */

import { useEffect, useState } from "preact/hooks";
import { SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { RuntimeSnapshot, SidebarCommand, SidebarEvent } from "@/lib/protocol";

export type BackgroundState = RuntimeSnapshot;

const INITIAL_STATE: BackgroundState = { page: null, lastSeq: 0, notice: null };

export function useBackground(): BackgroundState {
  const [state, setState] = useState<BackgroundState>(INITIAL_STATE);

  useEffect(() => {
    const port = browser.runtime.connect({ name: SIDEBAR_PORT_NAME });

    const onMessage = (message: unknown) => {
      const event = message as SidebarEvent;
      if (event.type === "state.snapshot") {
        setState(event.payload);
      } else if (event.type === "page.attached") {
        setState((prev) => ({ ...prev, page: event.payload }));
      }
    };
    port.onMessage.addListener(onMessage);

    const subscribe: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "state.subscribe", lastSeq: null };
    port.postMessage(subscribe);

    return () => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
    };
  }, []);

  return state;
}
