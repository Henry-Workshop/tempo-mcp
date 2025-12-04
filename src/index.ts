#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TempoClient } from "./tempo-client.js";

// Environment variables
const TEMPO_API_TOKEN = process.env.TEMPO_API_TOKEN;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_ACCOUNT_FIELD_ID = process.env.JIRA_ACCOUNT_FIELD_ID || "10026";
const DEFAULT_ROLE = process.env.DEFAULT_ROLE || "Dev";
const DEFAULT_PROJECTS_DIR = process.env.DEFAULT_PROJECTS_DIR || "";
const DEFAULT_MONDAY_MEETING_ISSUE = process.env.DEFAULT_MONDAY_MEETING_ISSUE || "BS-14";

// Gmail IMAP (optional - for email-based task detection)
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";

if (!TEMPO_API_TOKEN || !JIRA_API_TOKEN || !JIRA_EMAIL || !JIRA_BASE_URL) {
  console.error("Missing required environment variables:");
  console.error("  TEMPO_API_TOKEN - Tempo API token");
  console.error("  JIRA_API_TOKEN - Jira API token");
  console.error("  JIRA_EMAIL - Jira account email");
  console.error("  JIRA_BASE_URL - Jira base URL (e.g., https://company.atlassian.net)");
  console.error("\nOptional (for email integration):");
  console.error("  GMAIL_USER - Gmail email address");
  console.error("  GMAIL_APP_PASSWORD - Gmail app password (from Google Account > Security > App passwords)");
  process.exit(1);
}

const tempoClient = new TempoClient({
  tempoToken: TEMPO_API_TOKEN,
  jiraToken: JIRA_API_TOKEN,
  jiraEmail: JIRA_EMAIL,
  jiraBaseUrl: JIRA_BASE_URL,
  accountFieldId: JIRA_ACCOUNT_FIELD_ID,
  defaultRole: DEFAULT_ROLE,
  gmailUser: GMAIL_USER || undefined,
  gmailAppPassword: GMAIL_APP_PASSWORD || undefined,
});

const server = new Server(
  {
    name: "tempo-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "tempo_get_worklogs",
        description: "Retrieve worklogs for a date range",
        inputSchema: {
          type: "object",
          properties: {
            startDate: {
              type: "string",
              description: "Start date (YYYY-MM-DD)",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            endDate: {
              type: "string",
              description: "End date (YYYY-MM-DD)",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
          },
          required: ["startDate", "endDate"],
        },
      },
      {
        name: "tempo_create_worklog",
        description:
          "Create a new worklog with role and account support. Account is automatically fetched from the issue if not provided.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "Jira issue key (e.g., PROJ-123)",
            },
            timeSpentHours: {
              type: "number",
              description: "Time spent in hours (e.g., 1.5 for 1h30m)",
              exclusiveMinimum: 0,
            },
            date: {
              type: "string",
              description: "Date of the worklog (YYYY-MM-DD)",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            description: {
              type: "string",
              description: "Description of the work done",
            },
            startTime: {
              type: "string",
              description: "Start time (HH:MM)",
              pattern: "^([01]\\d|2[0-3]):([0-5]\\d)$",
            },
            role: {
              type: "string",
              description: `Role for the worklog (default: ${DEFAULT_ROLE})`,
            },
            accountKey: {
              type: "string",
              description:
                "Account key (optional - will use issue's account if not provided)",
            },
          },
          required: ["issueKey", "timeSpentHours", "date"],
        },
      },
      {
        name: "tempo_update_worklog",
        description: "Update an existing worklog",
        inputSchema: {
          type: "object",
          properties: {
            worklogId: {
              type: "string",
              description: "Tempo worklog ID",
            },
            timeSpentHours: {
              type: "number",
              description: "Time spent in hours",
              exclusiveMinimum: 0,
            },
            date: {
              type: "string",
              description: "Date of the worklog (YYYY-MM-DD)",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            description: {
              type: "string",
              description: "Description of the work done",
            },
            startTime: {
              type: "string",
              description: "Start time (HH:MM)",
              pattern: "^([01]\\d|2[0-3]):([0-5]\\d)$",
            },
            role: {
              type: "string",
              description: "Role for the worklog",
            },
            accountKey: {
              type: "string",
              description: "Account key",
            },
          },
          required: ["worklogId", "timeSpentHours"],
        },
      },
      {
        name: "tempo_delete_worklog",
        description: "Delete a worklog",
        inputSchema: {
          type: "object",
          properties: {
            worklogId: {
              type: "string",
              description: "Tempo worklog ID to delete",
            },
          },
          required: ["worklogId"],
        },
      },
      {
        name: "tempo_get_work_attributes",
        description: "Get available work attributes (roles, accounts, etc.)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "tempo_get_roles",
        description: "Get available Tempo roles",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "tempo_log_sprint_meeting",
        description: "Log time for sprint meetings (daily, planning, retro, etc). Automatically finds the 'Sprint Meetings' issue for the project.",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: {
              type: "string",
              description: "Project key (e.g., BERGA, SWIM)",
            },
            timeSpentMinutes: {
              type: "number",
              description: "Time spent in minutes (e.g., 15, 30, 60)",
              exclusiveMinimum: 0,
            },
            description: {
              type: "string",
              description: "Description (e.g., Daily, Sprint Planning, Retro)",
            },
            date: {
              type: "string",
              description: "Date (YYYY-MM-DD). Defaults to today if not provided.",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
          },
          required: ["projectKey", "timeSpentMinutes", "description"],
        },
      },
      {
        name: "tempo_generate_timesheet",
        description: `Generate timesheet from git commits. Scans all git repositories in a directory, extracts commits for the week (Mon-Thu), and creates worklogs based on Jira issue keys found in commit messages. Includes 15min daily sprint meetings and 15min Monday meeting. Uses JIRA_EMAIL as git author.${DEFAULT_PROJECTS_DIR ? ` Default projectsDir: ${DEFAULT_PROJECTS_DIR}` : ""}`,
        inputSchema: {
          type: "object",
          properties: {
            weekStart: {
              type: "string",
              description: "Monday date of the week (YYYY-MM-DD)",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            gitAuthor: {
              type: "string",
              description: `Git author email to filter commits (default: JIRA_EMAIL = ${JIRA_EMAIL})`,
            },
            projectsDir: {
              type: "string",
              description: `Directory containing git repositories${DEFAULT_PROJECTS_DIR ? ` (default: ${DEFAULT_PROJECTS_DIR})` : ""}`,
            },
            dryRun: {
              type: "boolean",
              description: "If true, only returns the plan without creating worklogs (default: true for safety)",
            },
            mondayMeetingIssue: {
              type: "string",
              description: `Jira issue for Monday team meeting (default: ${DEFAULT_MONDAY_MEETING_ISSUE})`,
            },
          },
          required: ["weekStart"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "tempo_get_worklogs": {
        const { startDate, endDate } = args as {
          startDate: string;
          endDate: string;
        };
        const worklogs = await tempoClient.getWorklogs(startDate, endDate);

        const formatted = worklogs.map((w) => {
          const hours = (w.timeSpentSeconds / 3600).toFixed(2);
          const role =
            w.attributes?.values.find((a) =>
              a.key.toLowerCase().includes("role") || a.key.toLowerCase().includes("rôle")
            )?.value || "N/A";
          const account =
            w.attributes?.values.find((a) =>
              a.key.toLowerCase().includes("account")
            )?.value || "N/A";

          return `WorklogId: ${w.tempoWorklogId} | Issue: ${w.issue.key || w.issue.id} | Date: ${w.startDate} | Hours: ${hours} | Role: ${role} | Account: ${account} | Description: ${w.description}`;
        });

        return {
          content: [
            {
              type: "text",
              text: formatted.join("\n") || "No worklogs found",
            },
          ],
        };
      }

      case "tempo_create_worklog": {
        const params = args as {
          issueKey: string;
          timeSpentHours: number;
          date: string;
          description?: string;
          startTime?: string;
          role?: string;
          accountKey?: string;
        };

        const worklog = await tempoClient.createWorklog(params);

        return {
          content: [
            {
              type: "text",
              text: `Worklog created successfully!\nID: ${worklog.tempoWorklogId}\nIssue: ${params.issueKey}\nTime: ${params.timeSpentHours}h\nDate: ${worklog.startDate}\nDescription: ${worklog.description}`,
            },
          ],
        };
      }

      case "tempo_update_worklog": {
        const params = args as {
          worklogId: string;
          timeSpentHours: number;
          date?: string;
          description?: string;
          startTime?: string;
          role?: string;
          accountKey?: string;
        };

        const worklog = await tempoClient.updateWorklog(params);

        return {
          content: [
            {
              type: "text",
              text: `Worklog updated successfully!\nID: ${worklog.tempoWorklogId}\nTime: ${params.timeSpentHours}h\nDate: ${worklog.startDate}`,
            },
          ],
        };
      }

      case "tempo_delete_worklog": {
        const { worklogId } = args as { worklogId: string };
        await tempoClient.deleteWorklog(worklogId);

        return {
          content: [
            {
              type: "text",
              text: `Worklog ${worklogId} deleted successfully`,
            },
          ],
        };
      }

      case "tempo_get_work_attributes": {
        const attributes = await tempoClient.getWorkAttributes();

        const formatted = attributes.map((a) => {
          let info = `Key: ${a.key} | Name: ${a.name} | Type: ${a.type} | Required: ${a.required}`;
          if (a.values) {
            info += `\n  Values: ${a.values.join(", ")}`;
          }
          if (a.names) {
            info += `\n  Names: ${JSON.stringify(a.names)}`;
          }
          return info;
        });

        return {
          content: [
            {
              type: "text",
              text: formatted.join("\n\n") || "No work attributes found",
            },
          ],
        };
      }

      case "tempo_get_roles": {
        const roles = await tempoClient.getRoles();

        const formatted = roles.map(
          (r) => `ID: ${r.id} | Name: ${r.name} | Default: ${r.default}`
        );

        return {
          content: [
            {
              type: "text",
              text: formatted.join("\n") || "No roles found",
            },
          ],
        };
      }

      case "tempo_log_sprint_meeting": {
        const { projectKey, timeSpentMinutes, description, date } = args as {
          projectKey: string;
          timeSpentMinutes: number;
          description: string;
          date?: string;
        };

        const issueKey = await tempoClient.findSprintMeetingsIssue(projectKey);
        if (!issueKey) {
          throw new Error(`No "Sprint Meetings" issue found for project ${projectKey}`);
        }

        const worklogDate = date || new Date().toISOString().split('T')[0];
        const worklog = await tempoClient.createWorklog({
          issueKey,
          timeSpentHours: timeSpentMinutes / 60,
          date: worklogDate,
          description,
        });

        return {
          content: [
            {
              type: "text",
              text: `Sprint meeting logged!\nID: ${worklog.tempoWorklogId}\nIssue: ${issueKey}\nTime: ${timeSpentMinutes} min\nDate: ${worklogDate}\nDescription: ${description}`,
            },
          ],
        };
      }

      case "tempo_generate_timesheet": {
        const rawParams = args as {
          weekStart: string;
          gitAuthor?: string;
          projectsDir?: string;
          dryRun?: boolean;
          mondayMeetingIssue?: string;
        };

        // Apply defaults - use JIRA_EMAIL as git author (same for all devs)
        const params = {
          weekStart: rawParams.weekStart,
          gitAuthor: rawParams.gitAuthor || JIRA_EMAIL!,
          projectsDir: rawParams.projectsDir || DEFAULT_PROJECTS_DIR,
          dryRun: rawParams.dryRun ?? true, // Default to dry run for safety
          mondayMeetingIssue: rawParams.mondayMeetingIssue || DEFAULT_MONDAY_MEETING_ISSUE,
        };
        if (!params.projectsDir) {
          throw new Error("projectsDir is required. Set DEFAULT_PROJECTS_DIR env var or provide it in the request.");
        }

        const result = await tempoClient.generateTimesheet(params);

        // Format output
        let output = `📅 Timesheet for week starting ${params.weekStart}\n`;
        output += `📁 Scanned: ${params.projectsDir}\n`;
        output += `👤 Author: ${params.gitAuthor}\n`;
        output += `${params.dryRun ? "🔍 DRY RUN - No worklogs created\n" : ""}\n`;

        for (const day of result.days) {
          output += `\n--- ${day.dayOfWeek} (${day.date}) - ${day.totalHours.toFixed(2)}h ---\n`;
          if (day.entries.length === 0) {
            output += "  No entries\n";
          } else {
            for (const entry of day.entries) {
              output += `  ${entry.issueKey}: ${entry.hours.toFixed(2)}h - ${entry.description}\n`;
            }
          }
        }

        if (result.errors.length > 0) {
          output += `\n⚠️ Warnings/Errors:\n`;
          for (const error of result.errors) {
            output += `  - ${error}\n`;
          }
        }

        if (!params.dryRun) {
          output += `\n✅ Created ${result.worklogsCreated} worklogs`;
        }

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tempo MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
