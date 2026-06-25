import { useMemo } from "react";
import { useTranslation } from "@/i18n";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { useLocation, useNavigate } from "@/lib/router";

const items = [
  { value: "general", labelKey: "settings.nav.general", href: "/company/settings" },
  { value: "environments", labelKey: "settings.nav.environments", href: "/company/settings/environments" },
  { value: "cloud-upstream", labelKey: "settings.nav.cloudUpstream", href: "/company/settings/cloud-upstream" },
  { value: "members", labelKey: "settings.nav.members", href: "/company/settings/members" },
  { value: "invites", labelKey: "settings.nav.invites", href: "/company/settings/invites" },
  { value: "secrets", labelKey: "settings.nav.secrets", href: "/company/settings/secrets" },
  { value: "instance-profile", labelKey: "settings.nav.instanceProfile", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/profile` },
  { value: "instance-general", labelKey: "settings.nav.instanceGeneral", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/general` },
  { value: "instance-environments", labelKey: "settings.nav.instanceEnvironments", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/environments` },
  { value: "instance-access", labelKey: "settings.nav.instanceAccess", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/access` },
  { value: "instance-heartbeats", labelKey: "settings.nav.instanceHeartbeats", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats` },
  { value: "instance-experimental", labelKey: "settings.nav.instanceExperimental", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/experimental` },
  { value: "instance-plugins", labelKey: "settings.nav.instancePlugins", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins` },
  { value: "instance-adapters", labelKey: "settings.nav.instanceAdapters", href: `${INSTANCE_SETTINGS_PATH_PREFIX}/adapters` },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

export function getCompanySettingsTab(pathname: string): CompanySettingsTab {
  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`)) {
    return "instance-profile";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/access`)) {
    return "instance-access";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`)) {
    return "instance-environments";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats`)) {
    return "instance-heartbeats";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`)) {
    return "instance-experimental";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`)) {
    return "instance-plugins";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`)) {
    return "instance-adapters";
  }

  if (pathname.includes(`${INSTANCE_SETTINGS_PATH_PREFIX}/general`)) {
    return "instance-general";
  }

  if (pathname.includes("/company/settings/environments")) {
    return "instance-environments";
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
