# Office avatars (虛擬辦公室)

Drop image files here (transparent-background PNG, ~512×512, head-and-shoulders)
to override the auto-generated cartoon avatars on the Virtual Office page.

Resolution order per agent (see ui/src/lib/office-avatars.ts):
1. A per-agent custom image keyed by the agent's urlKey/name → e.g. jay.png
2. A generic gender image: male.png / female.png
3. DiceBear "adventurer" cartoon fallback (always works, no file needed)

Required files for the current 四季 setup:
- jay.png      — Jay's own avatar (the sunglasses + black jacket render)
- male.png     — generic MALE avatar, same 3D-render style
- female.png   — generic FEMALE avatar, same 3D-render style

If a file is missing, that agent automatically falls back to DiceBear — nothing
breaks. Add files anytime; no rebuild needed (Vite serves /office-avatars/* ).
