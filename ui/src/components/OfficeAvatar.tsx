import { useMemo, useState } from "react";
import { CartoonAvatar } from "./CartoonAvatar";
import { resolveAvatarSources, resolveGender } from "../lib/office-avatars";
import { cn } from "../lib/utils";

interface Props {
  agent: { id: string; name?: string | null; urlKey?: string | null; metadata?: Record<string, unknown> | null };
  size?: number;
  className?: string;
  animated?: boolean;
}

// Tries the resolved image sources in order (custom → gender generic); when all
// fail (file not present yet), falls back to a DiceBear cartoon seeded so male
// and female still look distinct. This makes the uploaded avatars plug-and-play
// while never showing a broken image.
export function OfficeAvatar({ agent, size = 56, className, animated = true }: Props) {
  const sources = useMemo(() => resolveAvatarSources(agent), [agent]);
  const [idx, setIdx] = useState(0);

  if (idx < sources.length) {
    return (
      <img
        src={sources[idx]}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setIdx((i) => i + 1)}
        className={cn("select-none rounded-full object-cover", animated && "office-avatar-idle", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  // DiceBear fallback — seed with a gender suffix so male/female differ visibly.
  const gender = resolveGender(agent);
  return <CartoonAvatar seed={`${agent.id}-${gender}`} size={size} className={className} animated={animated} />;
}
