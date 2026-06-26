import { History, MessagesSquare, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { normalizeCompanyPrefix } from "@/lib/company-routes";
import { usePluginSlots } from "@/plugins/slots";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";

/** The Google Chat connector owns the "Chat" section's pages. */
const CHAT_PLUGIN_KEY = "paperclip-plugin-google-chat";

/** Friendly icons per known chat page route; falls back to a chat bubble. */
const ROUTE_ICONS: Record<string, LucideIcon> = {
  "chat-logs": History,
  "chat-assignments": Users,
};

/** i18n key per known chat page route, so the sidebar label localizes with the
 * app language instead of using the plugin's static English manifest name. */
const ROUTE_LABEL_KEYS: Record<string, string> = {
  "chat-logs": "nav.chatLogs",
  "chat-assignments": "nav.assignments",
};

/**
 * Top-level "Chat" navigation section. Surfaces the Google Chat plugin's
 * top-level `page` slots (Chat Logs, Assignments) as their own section alongside
 * Work / Projects, instead of burying them under Company Settings. Renders
 * nothing when the plugin isn't installed/enabled for the active company, so it
 * stays out of the way on instances without the connector.
 */
export function SidebarChat() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { slots } = usePluginSlots({
    slotTypes: ["page"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  // The Chat Logs + Assignments pages are an org-wide oversight view (everyone's
  // conversations). Restrict the whole section to instance admins and company
  // owners/admins; operators/viewers (e.g. Frank) never see it.
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const role = boardAccess?.memberships?.find((m) => m.companyId === selectedCompanyId)?.membershipRole;
  const canSeeChatSection =
    Boolean(boardAccess?.isInstanceAdmin) || role === "owner" || role === "admin";

  // Plugin `page` routes are company-scoped (/:companyPrefix/<routePath>) and,
  // unlike built-in board roots, have no prefix-less redirect — so the link MUST
  // carry the active company's prefix, or the router reads the routePath itself
  // as a (non-existent) company prefix.
  const prefix = selectedCompany ? normalizeCompanyPrefix(selectedCompany.issuePrefix) : null;
  const chatSlots = slots.filter(
    (slot) => slot.pluginKey === CHAT_PLUGIN_KEY && slot.routePath,
  );
  if (!prefix || chatSlots.length === 0 || !canSeeChatSection) return null;

  return (
    <SidebarSection label={t("nav.chat", { defaultValue: "Chat" })}>
      {chatSlots.map((slot) => (
        <SidebarNavItem
          key={`${slot.pluginKey}:${slot.id}`}
          to={`/${prefix}/${slot.routePath}`}
          label={
            ROUTE_LABEL_KEYS[slot.routePath ?? ""]
              ? t(ROUTE_LABEL_KEYS[slot.routePath ?? ""], { defaultValue: slot.displayName })
              : slot.displayName
          }
          icon={ROUTE_ICONS[slot.routePath ?? ""] ?? MessagesSquare}
        />
      ))}
    </SidebarSection>
  );
}
