import { Eye } from "lucide-react";
import type { IssueProductivityReview } from "@paperclipai/shared";
import { t, useTranslation } from "@/i18n";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const TRIGGER_LABEL_KEYS: Record<string, string> = {
  no_comment_streak: "productivityReview.trigger.noCommentStreak",
  long_active_duration: "productivityReview.trigger.longActiveDuration",
  high_churn: "productivityReview.trigger.highChurn",
};

const REVIEW_STATUS_LABEL_KEYS: Record<string, string> = {
  todo: "productivityReview.status.open",
  in_progress: "productivityReview.status.inProgress",
  in_review: "productivityReview.status.inReview",
  blocked: "productivityReview.status.blocked",
  backlog: "productivityReview.status.open",
};

export function productivityReviewTriggerLabel(
  trigger: IssueProductivityReview["trigger"],
): string {
  if (!trigger) return t("productivityReview.title");
  const key = TRIGGER_LABEL_KEYS[trigger];
  return key ? t(key) : t("productivityReview.title");
}

export function ProductivityReviewBadge({
  review,
  className,
  hideLabel = false,
}: {
  review: IssueProductivityReview;
  className?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const label = productivityReviewTriggerLabel(review.trigger);
  const reviewIdentifier = review.reviewIdentifier ?? review.reviewIssueId.slice(0, 8);
  const reviewPath = createIssueDetailPath(review.reviewIdentifier ?? review.reviewIssueId);
  const statusLabelKey = REVIEW_STATUS_LABEL_KEYS[review.status];
  const statusLabel = statusLabelKey ? t(statusLabelKey) : review.status.replace(/_/g, " ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={reviewPath}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 shrink-0 hover:bg-amber-500/20 transition-colors",
            className,
          )}
          aria-label={t("productivityReview.badgeAria", { identifier: reviewIdentifier, label })}
        >
          <Eye className="h-3 w-3" aria-hidden />
          {hideLabel ? null : <span>{t("productivityReview.underReview")}</span>}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{t("issues.productivityReviewOpen")}</div>
          <div>
            <span className="text-muted-foreground">{t("productivityReview.triggerLabel")}</span> {label}
          </div>
          {typeof review.noCommentStreak === "number" && review.noCommentStreak > 0 ? (
            <div>
              <span className="text-muted-foreground">{t("productivityReview.noCommentStreakLabel")}</span>{" "}
              {t("productivityReview.runsCount", { count: review.noCommentStreak })}
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">{t("productivityReview.reviewLabel")}</span> {reviewIdentifier} ({statusLabel})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
