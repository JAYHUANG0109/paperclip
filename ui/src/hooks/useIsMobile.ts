import { useEffect, useState } from "react";

// Matches Tailwind's `md` breakpoint (<768px = mobile). Used to swap in
// mobile-specific layouts (e.g. the Virtual Office room-card list) rather than
// scaling a desktop layout down to an unreadable size. SSR-safe: defaults to
// false until the media query is read on mount.
const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return isMobile;
}
