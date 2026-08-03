import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ExternalLink, Loader2, Plug } from "lucide-react";
import { useTranslation } from "@/i18n";
import { dashboardApi, type ConnectionsStatus } from "../api/dashboard";
import { ApiError } from "../api/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

const ASANA_PAT_HELP = "https://app.asana.com/0/my-apps";
const ODOO_KEY_HELP = "https://eip.seasonarts.ltd/odoo/settings";

/**
 * Persistent Connections card: shows the caller's own agent's Asana + Odoo
 * connection status and lets them paste/update each key at any time — not only
 * during onboarding. Keys are write-only from here; the server never returns
 * them, so a connected row shows only non-secret identifiers (workspace / login).
 */
export function ConnectionsCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["connections", companyId],
    queryFn: () => dashboardApi.connections(companyId),
  });

  // Nothing to connect to until the signed-in user has their own agent.
  if (!isLoading && data && !data.agentLinked) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Plug className="size-4 text-muted-foreground" />
          {t("connections.title", { defaultValue: "Connections" })}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("connections.subtitle", {
            defaultValue: "Your personal keys. Every agent you're responsible for uses them, acting as you.",
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <AsanaRow companyId={companyId} status={data?.asana} loading={isLoading} />
        <OdooRow companyId={companyId} status={data?.odoo} loading={isLoading} />
      </CardContent>
    </Card>
  );
}

export function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        connected ? "bg-green-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

/** Shared shell: header line (name + status + toggle) with an expandable form. */
export function ConnectionRow({
  name,
  connected,
  detail,
  loading,
  children,
}: {
  name: string;
  connected: boolean;
  detail: string;
  loading: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusDot connected={connected} />
        <span className="text-sm font-medium">{name}</span>
        <span className="ml-1 truncate text-xs text-muted-foreground">
          {loading ? t("connections.checking", { defaultValue: "Checking…" }) : detail}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 shrink-0 gap-1 text-xs"
          onClick={() => setOpen((v) => !v)}
        >
          {connected
            ? t("connections.update", { defaultValue: "Update" })
            : t("connections.connect", { defaultValue: "Connect" })}
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        </Button>
      </div>
      {open ? <div className="border-t border-border px-3 py-2.5">{children(() => setOpen(false))}</div> : null}
    </div>
  );
}

function HelpLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
}

function AsanaRow({
  companyId,
  status,
  loading,
}: {
  companyId: string;
  status: ConnectionsStatus["asana"] | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connected = status?.connected ?? false;

  const save = useMutation({
    mutationFn: (close: () => void) =>
      dashboardApi.connectAsana(companyId, token.trim()).then((r) => ({ r, close })),
    onSuccess: ({ close }) => {
      setError(null);
      setToken("");
      qc.invalidateQueries({ queryKey: ["connections", companyId] });
      qc.invalidateQueries({ queryKey: ["asana-digest", companyId] });
      close();
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : t("connections.asanaError", { defaultValue: "Could not save your Asana token. Check it and try again." }),
      ),
  });

  return (
    <ConnectionRow
      name="Asana"
      connected={connected}
      loading={loading}
      detail={
        connected
          ? t("connections.connected", { defaultValue: "Connected" })
          : t("connections.notConnected", { defaultValue: "Not connected" })
      }
    >
      {(close) => (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("connections.asanaPlaceholder", { defaultValue: "Paste your Asana Personal Access Token" })}
              className="h-8 font-mono text-xs"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter" && token.trim() && !save.isPending) save.mutate(close);
              }}
            />
            <Button size="sm" className="h-8 shrink-0" disabled={!token.trim() || save.isPending} onClick={() => save.mutate(close)}>
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : t("connections.save", { defaultValue: "Save" })}
            </Button>
          </div>
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <HelpLink href={ASANA_PAT_HELP} label={t("connections.asanaHelp", { defaultValue: "Create a token at app.asana.com → My apps" })} />
          )}
        </div>
      )}
    </ConnectionRow>
  );
}

function OdooRow({
  companyId,
  status,
  loading,
}: {
  companyId: string;
  status: ConnectionsStatus["odoo"] | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [login, setLogin] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [okDb, setOkDb] = useState<string | null>(null);
  const connected = status?.connected ?? false;

  const save = useMutation({
    mutationFn: (close: () => void) =>
      dashboardApi.connectOdoo(companyId, login.trim(), apiKey.trim()).then((r) => ({ r, close })),
    onSuccess: ({ r, close }) => {
      setError(null);
      setApiKey("");
      setOkDb(r.db ?? null);
      qc.invalidateQueries({ queryKey: ["connections", companyId] });
      close();
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : t("connections.odooError", { defaultValue: "Could not verify your Odoo key. Check the login + key and try again." }),
      ),
  });

  const canSave = login.trim().length > 2 && apiKey.trim().length >= 16 && !save.isPending;

  return (
    <ConnectionRow
      name="Odoo"
      connected={connected}
      loading={loading}
      detail={
        connected
          ? t("connections.odooConnectedAs", {
              defaultValue: "Connected as {{login}}",
              login: status?.login ?? "?",
            }) + (status?.db ? ` · ${status.db}` : "")
          : okDb
            ? t("connections.odooVerified", { defaultValue: "Verified · {{db}}", db: okDb })
            : t("connections.notConnected", { defaultValue: "Not connected" })
      }
    >
      {() => (
        <div className="space-y-1.5">
          <Input
            type="text"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder={t("connections.odooLoginPlaceholder", { defaultValue: "Your Odoo login (e.g. you@seasonart.org)" })}
            className="h-8 text-xs"
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("connections.odooKeyPlaceholder", { defaultValue: "Paste your Odoo API key (read-only)" })}
              className="h-8 font-mono text-xs"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) save.mutate(() => {});
              }}
            />
            <Button size="sm" className="h-8 shrink-0" disabled={!canSave} onClick={() => save.mutate(() => {})}>
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : t("connections.save", { defaultValue: "Save" })}
            </Button>
          </div>
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3 text-muted-foreground/70" />
              {t("connections.odooHelp", {
                defaultValue: "The key is verified against Odoo before saving. Read-only; create one in 設定 → 我的API金鑰.",
              })}
              <HelpLink href={ODOO_KEY_HELP} label="" />
            </div>
          )}
        </div>
      )}
    </ConnectionRow>
  );
}
