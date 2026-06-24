import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t, useTranslation } from "@/i18n";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

function buildSections(): ShortcutSection[] {
  return [
    {
      title: t("keyboardShortcuts.section.inbox"),
      shortcuts: [
        { keys: ["j"], label: t("keyboardShortcuts.moveDown") },
        { keys: ["↓"], label: t("keyboardShortcuts.moveDown") },
        { keys: ["k"], label: t("keyboardShortcuts.moveUp") },
        { keys: ["↑"], label: t("keyboardShortcuts.moveUp") },
        { keys: ["←"], label: t("keyboardShortcuts.collapseGroup") },
        { keys: ["→"], label: t("keyboardShortcuts.expandGroup") },
        { keys: ["Enter"], label: t("keyboardShortcuts.openItem") },
        { keys: ["a"], label: t("keyboardShortcuts.archiveItem") },
        { keys: ["y"], label: t("keyboardShortcuts.archiveItem") },
        { keys: ["r"], label: t("keyboardShortcuts.markRead") },
        { keys: ["U"], label: t("keyboardShortcuts.markUnread") },
      ],
    },
    {
      title: t("keyboardShortcuts.section.issueDetail"),
      shortcuts: [
        { keys: ["y"], label: t("keyboardShortcuts.quickArchive") },
        { keys: ["g", "i"], label: t("keyboardShortcuts.goToInbox") },
        { keys: ["g", "c"], label: t("keyboardShortcuts.focusComposer") },
      ],
    },
    {
      title: t("keyboardShortcuts.section.global"),
      shortcuts: [
        { keys: ["/"], label: t("keyboardShortcuts.search") },
        { keys: ["c"], label: t("keyboardShortcuts.newIssue") },
        { keys: ["["], label: t("keyboardShortcuts.toggleSidebar") },
        { keys: ["]"], label: t("keyboardShortcuts.togglePanel") },
        { keys: ["?"], label: t("keyboardShortcuts.showShortcuts") },
      ],
    },
  ];
}

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-[0_1px_0_1px_hsl(var(--border))]">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  const { t } = useTranslation();
  const sections = buildSections();
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && <span className="text-xs text-muted-foreground">{t("keyboardShortcuts.then")}</span>}
                        <KeyCap>{key}</KeyCap>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {t("keyboardShortcuts.footerPrefix")} <KeyCap>Esc</KeyCap> {t("keyboardShortcuts.footerSuffix")}
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{t("keyboardShortcuts.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
