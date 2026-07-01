import React, { useMemo, useState } from "react";
import { CartoonAvatar } from "./CartoonAvatar";
import { resolveAvatarSources, resolveGender, isSpriteSource } from "../lib/office-avatars";
import { bustCache } from "../lib/office-sprite-catalog";
import { cn } from "../lib/utils";

interface Props {
  agent: { id: string; name?: string | null; urlKey?: string | null; metadata?: Record<string, unknown> | null };
  size?: number;
  className?: string;
  animated?: boolean;
  style?: React.CSSProperties;
}

// Tries the resolved image sources in order (custom → gender generic); when all
// fail (file not present yet), falls back to a DiceBear cartoon seeded so male
// and female still look distinct. This makes the uploaded avatars plug-and-play
// while never showing a broken image.
export function OfficeAvatar({ agent, size = 56, className, animated = true, style }: Props) {
  const sources = useMemo(() => resolveAvatarSources(agent), [agent]);
  const [idx, setIdx] = useState(0);

  if (idx < sources.length) {
    const rawSrc = sources[idx]!;
    const sprite = isSpriteSource(rawSrc);
    const src = sprite ? bustCache(rawSrc) : rawSrc;
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setIdx((i) => i + 1)}
        className={cn(
          "select-none rounded-full",
          // Pixel sprites are full-body → contain (never crop) + crisp scaling.
          // Realistic/photo avatars → cover (fill the circle).
          sprite ? "object-contain" : "object-cover",
          animated && "office-avatar-idle",
          className,
        )}
        style={{ width: size, height: size, ...(sprite ? { imageRendering: "pixelated" } : {}), ...style }}
      />
    );
  }

  // DiceBear fallback — seed with a gender suffix so male/female differ visibly.
  const gender = resolveGender(agent);
  return <CartoonAvatar seed={`${agent.id}-${gender}`} size={size} className={className} animated={animated} />;
}
