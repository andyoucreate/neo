import { logger } from "./logger.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "#voltaire-dispatch";

export type SlackSeverity = "info" | "warning" | "error" | "success";

interface SlackMessage {
  channel: string;
  text: string;
  blocks?: SlackBlock[];
}

interface SlackBlock {
  type: "section" | "divider" | "header" | "context";
  text?: { type: "mrkdwn" | "plain_text"; text: string };
  fields?: Array<{ type: "mrkdwn"; text: string }>;
}

const SEVERITY_EMOJI: Record<SlackSeverity, string> = {
  info: ":information_source:",
  warning: ":warning:",
  error: ":rotating_light:",
  success: ":white_check_mark:",
};

/**
 * Post a notification to Slack.
 * Non-blocking — errors are logged but never thrown.
 */
export async function postToSlack(
  severity: SlackSeverity,
  title: string,
  details?: Record<string, string>,
): Promise<boolean> {
  if (!SLACK_WEBHOOK_URL) {
    logger.debug("Slack notification skipped (no SLACK_WEBHOOK_URL configured)");
    return false;
  }

  const emoji = SEVERITY_EMOJI[severity];
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${title}` },
    },
  ];

  if (details && Object.keys(details).length > 0) {
    blocks.push({
      type: "section",
      fields: Object.entries(details).map(([key, value]) => ({
        type: "mrkdwn" as const,
        text: `*${key}:*\n${value}`,
      })),
    });
  }

  const message: SlackMessage = {
    channel: SLACK_CHANNEL,
    text: `${emoji} ${title}`,
    blocks,
  };

  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn(`Slack notification failed: HTTP ${response.status}`);
      return false;
    }

    return true;
  } catch (error) {
    logger.warn("Slack notification failed", { error });
    return false;
  }
}

/**
 * Notify about pipeline completion.
 */
export async function notifyPipelineComplete(params: {
  pipeline: string;
  sessionId: string;
  status: string;
  costUsd: number;
  durationMs: number;
  ticketId?: string;
  prNumber?: number;
}): Promise<void> {
  const severity: SlackSeverity = params.status === "success" ? "success" : "error";
  const title = `Pipeline ${params.pipeline} ${params.status}`;
  const details: Record<string, string> = {
    "Session": params.sessionId,
    "Cost": `$${params.costUsd.toFixed(2)}`,
    "Duration": `${Math.round(params.durationMs / 1000)}s`,
  };

  if (params.ticketId) details["Ticket"] = params.ticketId;
  if (params.prNumber) details["PR"] = `#${params.prNumber}`;

  await postToSlack(severity, title, details);
}

/**
 * Notify about service-level events.
 */
export async function notifyServiceEvent(
  event: string,
  details?: Record<string, string>,
): Promise<void> {
  await postToSlack("info", `Dispatch Service: ${event}`, details);
}
