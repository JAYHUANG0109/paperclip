import { useState } from "react";
import { paletteById } from "../lib/office-characters";
import { cn } from "../lib/utils";

// Species with uploaded illustrated PNGs in /public/office-characters/<species>.png.
// These render as the real art; everything else falls back to the SVG critter.
// Add a species id here as each PNG is dropped in.
const PNG_SPECIES = new Set<string>(["cat"]);

export type CritterPose = "idle" | "walk" | "sit";

interface Props {
  species: string;
  palette: string;
  pose?: CritterPose;
  size?: number;
  className?: string;
}

// Hand-authored cute chibi critters as inline SVG — no image files, no generator.
// All share one rounded body; species differ by ears / muzzle / tail. The palette
// recolors fur+shade+belly and supplies a unifying outline (the illustrated look),
// so 6 species × 5 palettes = 30 looks from this one component. Poses animate via
// CSS (.office-critter-* in index.css). Iconic-color species (panda/penguin/frog/
// owl) aren't drawn yet — callers fall back to the species emoji for those.

type Ear = "pointed" | "round" | "tall" | "floppy";
type Tail = "cat" | "fox" | "puff" | "none";

const FEATURES: Record<string, { ear: Ear; innerEar: boolean; tail: Tail; muzzle: boolean }> = {
  cat: { ear: "pointed", innerEar: true, tail: "cat", muzzle: false },
  fox: { ear: "pointed", innerEar: true, tail: "fox", muzzle: true },
  dog: { ear: "floppy", innerEar: false, tail: "cat", muzzle: true },
  bunny: { ear: "tall", innerEar: true, tail: "puff", muzzle: false },
  bear: { ear: "round", innerEar: false, tail: "none", muzzle: true },
  hamster: { ear: "round", innerEar: true, tail: "none", muzzle: true },
};

export function critterHasArt(species: string): boolean {
  return species in FEATURES;
}

const SW = 1.9; // silhouette stroke width — a thick, consistent dark outline (sticker look)

export function OfficeCritter({ species, palette, pose = "idle", size = 64, className }: Props) {
  const [imgFailed, setImgFailed] = useState(false);

  // Real illustrated PNG (single sitting sprite) — motion comes from CSS transforms:
  // roaming → hop, working → typing bob, otherwise a gentle idle bob.
  if (PNG_SPECIES.has(species) && !imgFailed) {
    const motion = pose === "walk" ? "office-critter-hop" : pose === "sit" ? "office-critter-type" : "office-critter-idle";
    return (
      <img
        src={`/office-characters/${species}.png`}
        width={size}
        height={size}
        draggable={false}
        aria-hidden="true"
        onError={() => setImgFailed(true)}
        className={cn("select-none object-contain", motion, className)}
        style={{ width: size, height: size, transformOrigin: "center bottom" }}
      />
    );
  }

  const f = FEATURES[species];
  const pal = paletteById(palette);

  if (!f) {
    return (
      <span
        className={cn("inline-grid place-items-center select-none", pose !== "sit" && "office-critter-idle", className)}
        style={{ width: size, height: size, fontSize: size * 0.7, lineHeight: 1 }}
        aria-hidden="true"
      >
        {emojiFor(species)}
      </span>
    );
  }

  const { fur, shade, belly, outline } = pal;
  const sit = pose === "sit";
  // shared stroke props for silhouette shapes
  const stroke = { stroke: outline, strokeWidth: SW, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  const eyeY = f.muzzle ? 21 : 22;

  return (
    <svg
      viewBox="0 0 64 72"
      width={size}
      height={size}
      className={cn("select-none", pose === "walk" ? "office-critter-walk" : pose === "idle" ? "office-critter-idle" : undefined, className)}
      aria-hidden="true"
    >
      {renderTail(f.tail, fur, belly, outline)}

      {/* feet / legs */}
      <g className="leg-l">
        <ellipse cx={sit ? 27 : 24.5} cy={sit ? 64 : 64} rx="5" ry="3.9" fill={fur} {...stroke} />
      </g>
      <g className="leg-r">
        <ellipse cx={sit ? 37 : 39.5} cy={sit ? 64 : 64} rx="5" ry="3.9" fill={fur} {...stroke} />
      </g>

      {/* body */}
      <ellipse cx="32" cy={sit ? 49 : 47} rx="14.5" ry={sit ? 14 : 15.5} fill={fur} {...stroke} />
      <ellipse cx="32" cy={sit ? 51 : 50} rx="8.5" ry={sit ? 9 : 10} fill={belly} />

      {/* arms (reach forward to "type" when sitting) */}
      <ellipse cx={sit ? 23 : 18.5} cy={sit ? 53 : 46} rx="4.3" ry={sit ? 4.3 : 6.2} fill={fur} {...stroke} />
      <ellipse cx={sit ? 41 : 45.5} cy={sit ? 53 : 46} rx="4.3" ry={sit ? 4.3 : 6.2} fill={fur} {...stroke} />

      {/* ears (behind head so the joins read clean) */}
      {renderEars(f.ear, f.innerEar, fur, shade, belly, outline)}

      {/* head */}
      <ellipse cx="32" cy="21.5" rx="15.5" ry="14.5" fill={fur} {...stroke} />
      {f.muzzle && <ellipse cx="32" cy="27" rx="7.6" ry="5.6" fill={belly} />}

      {/* cheeks */}
      <ellipse cx="20.5" cy="26" rx="2.8" ry="1.9" fill="#ef9f97" opacity="0.42" />
      <ellipse cx="43.5" cy="26" rx="2.8" ry="1.9" fill="#ef9f97" opacity="0.42" />

      {/* eyes — small, round, sticker-style with a single highlight */}
      <ellipse cx="27" cy={eyeY} rx="2.3" ry="2.8" fill="#2d2a27" />
      <ellipse cx="37" cy={eyeY} rx="2.3" ry="2.8" fill="#2d2a27" />
      <circle cx="27.8" cy={eyeY - 0.9} r="0.95" fill="#fff" />
      <circle cx="37.8" cy={eyeY - 0.9} r="0.95" fill="#fff" />

      {/* nose + smile */}
      <ellipse cx="32" cy="25.6" rx="1.7" ry="1.3" fill="#574039" />
      <path
        d={f.muzzle ? "M28.5 28.2 Q32 31 35.5 28.2" : "M29.2 27.6 Q32 30 34.8 27.6"}
        fill="none"
        stroke={outline}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function renderEars(ear: Ear, innerEar: boolean, fur: string, shade: string, belly: string, outline: string) {
  const s = { stroke: outline, strokeWidth: SW, strokeLinejoin: "round" as const };
  if (ear === "pointed") {
    return (
      <g>
        <path d="M18 12 L22 0.5 L31 11 Z" fill={fur} {...s} />
        <path d="M46 12 L42 0.5 L33 11 Z" fill={fur} {...s} />
        {innerEar && (
          <>
            <path d="M21.5 10 L23.5 4 L28 10 Z" fill={shade} />
            <path d="M42.5 10 L40.5 4 L36 10 Z" fill={shade} />
          </>
        )}
      </g>
    );
  }
  if (ear === "round") {
    return (
      <g>
        <circle cx="20" cy="10" r="6.2" fill={fur} {...s} />
        <circle cx="44" cy="10" r="6.2" fill={fur} {...s} />
        {innerEar && (
          <>
            <circle cx="20" cy="10.5" r="3.1" fill={shade} />
            <circle cx="44" cy="10.5" r="3.1" fill={shade} />
          </>
        )}
      </g>
    );
  }
  if (ear === "tall") {
    return (
      <g>
        <g transform="rotate(-10 25.5 13)">
          <ellipse cx="25.5" cy="5" rx="4" ry="12" fill={fur} {...s} />
          {innerEar && <ellipse cx="25.5" cy="6" rx="1.9" ry="8.5" fill={belly} />}
        </g>
        <g transform="rotate(10 38.5 13)">
          <ellipse cx="38.5" cy="5" rx="4" ry="12" fill={fur} {...s} />
          {innerEar && <ellipse cx="38.5" cy="6" rx="1.9" ry="8.5" fill={belly} />}
        </g>
      </g>
    );
  }
  // floppy — hang beside the head
  return (
    <g>
      <ellipse cx="17.5" cy="24" rx="5.2" ry="9.5" fill={shade} {...s} />
      <ellipse cx="46.5" cy="24" rx="5.2" ry="9.5" fill={shade} {...s} />
    </g>
  );
}

function renderTail(tail: Tail, fur: string, belly: string, outline: string) {
  const s = { stroke: outline, strokeWidth: SW, strokeLinejoin: "round" as const };
  if (tail === "cat") return <path d="M45 51 C59 49 59 33 51 31 C57 38 49 47 43 46 Z" fill={fur} {...s} />;
  if (tail === "fox")
    return (
      <g>
        <path d="M44 51 C61 51 62 30 50 27 C58 36 48 48 42 46 Z" fill={fur} {...s} />
        <path d="M50 27 C56 29 57 35 54 39 C53 33 51 29 50 27 Z" fill={belly} />
      </g>
    );
  if (tail === "puff") return <circle cx="46" cy="51" r="5.2" fill={belly} {...s} />;
  return null;
}

function emojiFor(species: string): string {
  const map: Record<string, string> = { panda: "🐼", penguin: "🐧", frog: "🐸", owl: "🦉" };
  return map[species] ?? "🐱";
}
