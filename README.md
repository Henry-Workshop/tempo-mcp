# Tempo MCP Server

MCP (Model Context Protocol) server for Tempo time tracking with full support for **roles** and **accounts**.

## Features

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

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `TEMPO_API_TOKEN` | Yes | Tempo API token (get from Tempo > Settings > API Integration) |
| `JIRA_API_TOKEN` | Yes | Jira API token (get from id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_EMAIL` | Yes | Jira account email |
| `JIRA_BASE_URL` | Yes | Jira base URL (e.g., https://company.atlassian.net) |
| `JIRA_ACCOUNT_FIELD_ID` | No | Custom field ID for Tempo account (default: 10026) |
| `DEFAULT_ROLE` | No | Default role for worklogs (default: Dev) |

## Usage with Claude Code

Add to your Claude Code MCP configuration:

```bash
claude mcp add tempo-mcp -s user   -e TEMPO_API_TOKEN=your-tempo-token   -e JIRA_API_TOKEN=your-jira-token   -e JIRA_EMAIL=your-email@company.com   -e JIRA_BASE_URL=https://company.atlassian.net   -- node /path/to/tempo-mcp/dist/index.js
```

### Example configuration in claude.json

```json
{
  "mcpServers": {
    "tempo-mcp": {
      "command": "node",
      "args": ["/path/to/tempo-mcp/dist/index.js"],
      "env": {
        "TEMPO_API_TOKEN": "your-tempo-token",
        "JIRA_API_TOKEN": "your-jira-token",
        "JIRA_EMAIL": "your-email@company.com",
        "JIRA_BASE_URL": "https://company.atlassian.net"
      }
    }
  }
}
```

## Available Tools

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
