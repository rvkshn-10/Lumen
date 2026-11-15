import { useEffect, useState } from "react";
import { getCopilotStatus } from "../lib/api";

export function useCopilotAvailability(active: boolean) {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active || available !== null) return;
    const controller = new AbortController();
    getCopilotStatus(controller.signal)
      .then(result => { if (!controller.signal.aborted) setAvailable(result); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [active, available]);
  return available;
}
