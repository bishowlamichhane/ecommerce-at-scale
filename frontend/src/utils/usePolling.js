import { useEffect, useRef } from "react";

// Calls `fn` now and then every `intervalMs`, for as long as the component is
// on screen. A call never starts while the previous one is still running, and
// none run while the tab is hidden, so a slow API can't pile up requests.
export function usePolling(fn, intervalMs) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    let stopped = false;
    let timer;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          await latest.current();
        } catch {
          // the next tick tries again
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [intervalMs]);
}
