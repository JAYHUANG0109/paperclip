import { useMemo } from "react";
import { createAvatar, type Style } from "@dicebear/core";
import { adventurer, bigSmile, funEmoji, personas } from "@dicebear/collection";
import { cn } from "../lib/utils";

// Deterministic cartoon avatars (DiceBear). Each agent/user gets a stable,
// distinct cartoon face derived from a seed — no photo needed. This is the same
// technique behind the reference build's animal avatars, with nicer human-cartoon
// sets. The container does the "animation" (gentle idle float / working pulse);
// the SVG itself is static and rendered offline (no external requests).
const STYLES: Record<string, Style<Record<string, unknown>>> = {
  adventurer: adventurer as unknown as Style<Record<string, unknown>>,
  bigSmile: bigSmile as unknown as Style<Record<string, unknown>>,
  funEmoji: funEmoji as unknown as Style<Record<string, unknown>>,
  personas: personas as unknown as Style<Record<string, unknown>>,
};

export type CartoonAvatarStyle = keyof typeof STYLES;

interface Props {
  seed: string;
  size?: number;
  style?: CartoonAvatarStyle;
  className?: string;
  /** Adds a gentle idle bob; disable for static contexts. */
  animated?: boolean;
}

export function CartoonAvatar({ seed, size = 56, style = "adventurer", className, animated = true }: Props) {
  const dataUri = useMemo(() => {
    const avatar = createAvatar(STYLES[style] ?? STYLES.adventurer, {
      seed: seed || "paperclip",
      size,
      radius: 50,
      backgroundType: ["gradientLinear", "solid"],
    });
    return avatar.toDataUri();
  }, [seed, size, style]);

  return (
    <img
      src={dataUri}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("select-none", animated && "office-avatar-idle", className)}
      style={{ width: size, height: size }}
    />
  );
}
