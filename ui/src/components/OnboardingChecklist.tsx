import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, ExternalLink, GraduationCap, Loader2 } from "lucide-react";
import { useTranslation } from "@/i18n";
import { dashboardApi, type OnboardingStepView } from "../api/dashboard";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { ApiError } from "../api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

const ONBOARDING_KEY = (companyId: string) => ["onboarding", companyId];
const ASANA_PAT_HELP = "https://app.asana.com/0/my-apps";

/**
 * The logged-in user's 5-step onboarding (關卡), rendered as a dashboard
 * checklist. Auto-shows the moment their agent is seeded (on first login) and
 * auto-hides once every step is cleared. Step 1 (設定與連線) carries an inline
 * Asana Personal Access Token form — the human's own token, stored per-user so
 * every agent they own reuses it. Steps 2–5 complete on real server signals
 * (a task created, a reply sent, a skill built), so they show status + a deep
 * link to where the action happens rather than a self-attest checkbox.
 */
export function OnboardingChecklist({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ONBOARDING_KEY(companyId),
    queryFn: () => dashboardApi.onboarding(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });
  // The user's own agent, for the "go do it" deep links (task/collaborate steps).
  const { data: myAgents } = useQuery({
    queryKey: queryKeys.agents.mine(companyId),
    queryFn: () => agentsApi.mine(companyId),
    enabled: !!companyId,
  });
  const myAgentHref = myAgents?.[0] ? agentUrl(myAgents[0]) : null;

  if (!data?.available || !data.steps || data.status === "done") return null;

  const done = data.steps.filter((s) => s.done).length;
  const total = data.total ?? data.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <GraduationCap className="size-4 text-primary" />
          <CardTitle className="text-base">
            {t("onboardingGame.title", { defaultValue: "Getting started" })}
          </CardTitle>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {t("onboardingGame.progress", { defaultValue: "{{done}}/{{total}} done", done, total })}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {data.steps.map((step, i) => (
          <OnboardingStepRow
            key={step.key}
            step={step}
            index={i}
            companyId={companyId}
            myAgentHref={myAgentHref}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ONBOARDING_KEY(companyId) });
              queryClient.invalidateQueries({ queryKey: ["asana-digest", companyId] });
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function OnboardingStepRow({
  step,
  index,
  companyId,
  myAgentHref,
  onDone,
}: {
  step: OnboardingStepView;
  index: number;
  companyId: string;
  myAgentHref: string | null;
  onDone: () => void;
}) {
  // Short, human title without the "關卡 N｜" prefix the catalog carries.
  const title = step.title.replace(/^關卡\s*\d+\s*[｜|]\s*/, "");

  return (
    <div
      className={cn(
        "flex gap-3 rounded-md px-2 py-2",
        step.current && !step.done && "bg-accent/40",
      )}
    >
      <div className="mt-0.5 shrink-0">
        {step.done ? (
          <CheckCircle2 className="size-4 text-emerald-500" />
        ) : step.current ? (
          <ArrowRight className="size-4 text-primary" />
        ) : (
          <Circle className="size-4 text-muted-foreground/50" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm",
              step.done ? "text-muted-foreground" : step.current ? "font-medium" : "",
            )}
          >
            <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
            {title}
          </span>
        </div>
        {/* Details + the "go do it" affordance only for the current, not-yet-done
            step — keeps cleared and locked rows compact. */}
        {step.current && !step.done && (
          <div className="mt-1.5">
            <p className="text-xs leading-relaxed text-muted-foreground">{step.desc}</p>
            {step.key === "setup" ? (
              <AsanaConnectForm companyId={companyId} onDone={onDone} />
            ) : (
              <StepDeepLink stepKey={step.key} myAgentHref={myAgentHref} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the current non-setup step is completed. Task/collaborate happen in the
 *  user's own agent chat; dashboard/skills have their own pages. */
function StepDeepLink({ stepKey, myAgentHref }: { stepKey: string; myAgentHref: string | null }) {
  const { t } = useTranslation();
  const target =
    stepKey === "first-task" || stepKey === "collaborate"
      ? myAgentHref
      : stepKey === "skills-routines"
        ? "/skills"
        : "/dashboard";
  if (!target) return null;
  const label =
    stepKey === "first-task" || stepKey === "collaborate"
      ? t("onboardingGame.goToAgent", { defaultValue: "Go to My Agent" })
      : stepKey === "skills-routines"
        ? t("onboardingGame.goToSkills", { defaultValue: "Go to Skills" })
        : t("onboardingGame.goToDashboard", { defaultValue: "View dashboard sections below" });
  return (
    <Link
      to={target}
      className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      {label}
      <ArrowRight className="size-3" />
    </Link>
  );
}

function AsanaConnectForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => dashboardApi.connectAsana(companyId, token.trim()),
    onSuccess: () => {
      setError(null);
      setToken("");
      onDone();
    },
    onError: (e) => {
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : t("onboardingGame.asanaError", { defaultValue: "Could not save your Asana token. Check it and try again." }),
      );
    },
  });

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex gap-2">
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("onboardingGame.asanaPlaceholder", { defaultValue: "Paste your Asana Personal Access Token" })}
          className="h-8 font-mono text-xs"
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter" && token.trim() && !save.isPending) save.mutate();
          }}
        />
        <Button
          size="sm"
          className="h-8 shrink-0"
          disabled={!token.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : t("onboardingGame.save", { defaultValue: "Save" })}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <a
          href={ASANA_PAT_HELP}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {t("onboardingGame.asanaHelp", { defaultValue: "Create a token at app.asana.com → My apps" })}
          <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
