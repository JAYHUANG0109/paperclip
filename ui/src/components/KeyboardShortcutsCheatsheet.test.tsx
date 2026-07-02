// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyboardShortcutsCheatsheetContent } from "./KeyboardShortcutsCheatsheet";

describe("KeyboardShortcutsCheatsheet", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("lists the sidebar toggle shortcut with the correct label and key", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    // Our UI uses "[" to toggle the sidebar (not a Cmd/Ctrl+B chord).
    // The label is "Toggle sidebar" from the i18n key keyboardShortcuts.toggleSidebar.
    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent?.trim() === "Toggle sidebar",
    )?.parentElement;
    expect(row).toBeTruthy();

    // Rendered as a single key "[", not a multi-key sequence.
    const caps = [...(row?.querySelectorAll("kbd") ?? [])].map((kbd) => kbd.textContent);
    expect(caps).toContain("[");
    expect(row?.textContent).not.toContain("then");

    flushSync(() => {
      root.unmount();
    });
  });
});
