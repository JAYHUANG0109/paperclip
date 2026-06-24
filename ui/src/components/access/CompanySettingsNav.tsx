import { useMemo } from "react";
import { useTranslation } from "@/i18n";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useLocation, useNavigate } from "@/lib/router";

const items = [
  { value: "general", labelKey: "settings.nav.general", href: "/company/settings" },
  { value: "environments", labelKey: "settings.nav.environments", href: "/company/settings/environments" },
  { value: "cloud-upstream", labelKey: "settings.nav.cloudUpstream", href: "/company/settings/cloud-upstream" },
  { value: "members", labelKey: "settings.nav.members", href: "/company/settings/members" },
  { value: "invites", labelKey: "settings.nav.invites", href: "/company/settings/invites" },
  { value: "secrets", labelKey: "settings.nav.secrets", href: "/company/settings/secrets" },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
  if (pathname.includes("/company/settings/environments")) {
    return "environments";
  }

  if (pathname.includes("/company/settings/cloud-upstream")) {
    return "cloud-upstream";
  }

  if (pathname.includes("/company/settings/members") || pathname.includes("/company/settings/access")) {
    return "members";
  }

  if (pathname.includes("/company/settings/invites")) {
    return "invites";
  }

  if (pathname.includes("/company/settings/secrets")) {
    return "secrets";
  }

  return "general";
}

export function CompanySettingsNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = getCompanySettingsTab(location.pathname);
  const tabItems = useMemo(
    () => items.map(({ value, labelKey }) => ({ value, label: t(labelKey) })),
    [t],
  );

  function handleTabChange(value: string) {
    const nextTab = items.find((item) => item.value === value);
    if (!nextTab || nextTab.value === activeTab) return;
    navigate(nextTab.href);
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <PageTabBar
        items={tabItems}
        value={activeTab}
        onValueChange={handleTabChange}
        align="start"
      />
    </Tabs>
  );
}
