# Tempo MCP Server

MCP (Model Context Protocol) server for Tempo time tracking with full support for **roles** and **accounts**.

## Features

- **Auto-generate timesheets from git commits** - scans all your repos and creates worklogs automatically
- Create worklogs with role and account attributes
- Automatically fetch account from Jira issue
- **Auto-fallback to active account** when issue's account is closed/archived
- **Quick sprint meeting logging** - just specify project and minutes
- Update and delete worklogs
- List worklogs for date ranges
- Get available work attributes and roles

## Installation

```bash
npm install
npm run build
```

## Configuration

### Getting your API tokens

**Tempo API Token:**
1. Go to [Tempo > Settings](https://app.tempo.io/settings) in your Jira instance
2. Click on **API Integration** in the left sidebar
3. Click **New Token**
4. Give it a name (e.g., "Claude Code MCP")
5. Select permissions: **Manage Worklogs** (or Full Access)
6. Copy the generated token

**Jira API Token:**
1. Go to [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a label (e.g., "Claude Code MCP")
4. Copy the generated token

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TEMPO_API_TOKEN` | Yes | Tempo API token (get from Tempo > Settings > API Integration) |
| `JIRA_API_TOKEN` | Yes | Jira API token (get from id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_EMAIL` | Yes | Jira account email |
| `JIRA_BASE_URL` | Yes | Jira base URL (e.g., https://company.atlassian.net) |
| `JIRA_ACCOUNT_FIELD_ID` | No | Custom field ID for Tempo account (default: 10026) |
| `DEFAULT_ROLE` | No | Default role for worklogs (default: Dev) |
| `DEFAULT_PROJECTS_DIR` | No | Default directory for git repos (e.g., C:/Users/you/Projects) |
| `DEFAULT_MONDAY_MEETING_ISSUE` | No | Jira issue for Monday team meeting (default: BS-14) |

> **Note:** `gitAuthor` defaults to `JIRA_EMAIL` since they're the same for all developers.

## Usage with Claude Code

### Quick Setup (one command)

**Linux/macOS:**
```bash
claude mcp add tempo-mcp -s user \
  -e TEMPO_API_TOKEN=your-tempo-token \
  -e JIRA_API_TOKEN=your-jira-token \
  -e JIRA_EMAIL=your-email@company.com \
  -e JIRA_BASE_URL=https://company.atlassian.net \
  -e DEFAULT_PROJECTS_DIR=/home/you/projects \
  -- npx -y github:Henry-Workshop/tempo-mcp
```

**Windows (PowerShell):**
```powershell
claude mcp add tempo-mcp -s user `
  -e TEMPO_API_TOKEN=your-tempo-token `
  -e JIRA_API_TOKEN=your-jira-token `
  -e JIRA_EMAIL=your-email@company.com `
  -e JIRA_BASE_URL=https://company.atlassian.net `
  -e DEFAULT_PROJECTS_DIR=C:/Users/you/Projects `
  -- npx.cmd -y github:Henry-Workshop/tempo-mcp
```

### Example configuration in claude.json

```json
{
  "mcpServers": {
    "tempo-mcp": {
      "command": "npx",
      "args": ["-y", "github:Henry-Workshop/tempo-mcp"],
      "env": {
        "TEMPO_API_TOKEN": "your-tempo-token",
        "JIRA_API_TOKEN": "your-jira-token",
        "JIRA_EMAIL": "your-email@company.com",
        "JIRA_BASE_URL": "https://company.atlassian.net",
        "DEFAULT_PROJECTS_DIR": "C:/Users/you/Projects"
      }
    }
  }
}
```

## Available Tools

### tempo_generate_timesheet

**The main feature!** Automatically generate your weekly timesheet from git commits.

```json
{
  "weekStart": "2025-12-01",
  "gitAuthor": "your-email@company.com",
  "projectsDir": "C:/Users/you/Projects",
  "dryRun": true,
  "mondayMeetingIssue": "BS-14"
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `weekStart` | Yes | Monday date of the week (YYYY-MM-DD) |
| `gitAuthor` | Yes | Your git author email or name |
| `projectsDir` | Yes | Directory containing all your git repositories |
| `dryRun` | No | If true, shows plan without creating worklogs (default: false) |
| `mondayMeetingIssue` | No | Jira issue for Monday team meeting (default: BS-14) |

**What it does:**
1. Scans all git repos in `projectsDir`
2. Extracts your commits for Monday-Thursday
3. Parses Jira issue keys from commit messages (e.g., `PROJ-123`)
4. Distributes 8h/day based on commit count per issue
5. Adds 15min daily sprint meeting (on the main project of the day)
6. Adds 15min Monday team sync on BS-14
7. Generates client-friendly descriptions from commit messages
8. Creates worklogs in Tempo

**Example usage in Claude Code:**
- "fait ma feuille de temps de cette semaine"
- "generate my timesheet for last week"
- "do my timesheet for the week of december 1st in dry run mode"

**Important:** Your commit messages should include Jira issue keys (e.g., `PROJ-123 fix: description`). Commits without issue keys will be flagged as warnings.

---

### tempo_log_sprint_meeting

Quick way to log time for sprint meetings (daily, planning, retro). Automatically finds the "Sprint Meetings" issue for the project.

```json
{
  "projectKey": "PROJ",
  "timeSpentMinutes": 15,
  "description": "Daily",
  "date": "2025-11-27"
}
```

**Example usage in Claude Code:**
- "add 15 mins for sprint meetings for BERGA"
- "log daily 15 mins to CRC project"

### tempo_create_worklog

Create a new worklog with role and account support.

```json
{
  "issueKey": "PROJ-123",
  "timeSpentHours": 1.5,
  "date": "2025-11-27",
  "description": "Working on feature",
  "role": "Dev",
  "accountKey": "ACCOUNT-KEY"
}
```

If `accountKey` is not provided, it will be automatically fetched from the Jira issue. If the account is closed/archived, it will automatically find an active account from recent project issues.

### tempo_get_worklogs

Retrieve worklogs for a date range.

```json
{
  "startDate": "2025-11-01",
  "endDate": "2025-11-30"
}
```

### tempo_update_worklog

Update an existing worklog.

```json
{
  "worklogId": "12345",
  "timeSpentHours": 2,
  "description": "Updated description"
}
```

### tempo_delete_worklog

Delete a worklog.

```json
{
  "worklogId": "12345"
}
```

### tempo_get_work_attributes

Get available work attributes (roles, accounts configuration).

### tempo_get_roles

Get available Tempo roles.

## License

MIT
