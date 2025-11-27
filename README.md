# Tempo MCP Server

MCP (Model Context Protocol) server for Tempo time tracking with full support for **roles** and **accounts**.

## Features

- Create worklogs with role and account attributes
- Automatically fetch account from Jira issue
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
| `TEMPO_API_TOKEN` | Yes | Tempo API token |
| `JIRA_API_TOKEN` | Yes | Jira API token |
| `JIRA_EMAIL` | Yes | Jira account email |
| `JIRA_BASE_URL` | Yes | Jira base URL (e.g., https://company.atlassian.net) |
| `JIRA_ACCOUNT_FIELD_ID` | No | Custom field ID for Tempo account (default: 10026) |
| `DEFAULT_ROLE` | No | Default role for worklogs (default: Dev) |

## Usage with Claude Code

Add to your Claude Code MCP configuration:

```bash
claude mcp add tempo-mcp -s user \
  -e TEMPO_API_TOKEN=your-tempo-token \
  -e JIRA_API_TOKEN=your-jira-token \
  -e JIRA_EMAIL=your-email@company.com \
  -e JIRA_BASE_URL=https://company.atlassian.net \
  -e JIRA_ACCOUNT_FIELD_ID=10026 \
  -e DEFAULT_ROLE=Dev \
  -- node /path/to/tempo-mcp/dist/index.js
```

Or with npx after publishing:

```bash
claude mcp add tempo-mcp -s user \
  -e TEMPO_API_TOKEN=your-tempo-token \
  -e JIRA_API_TOKEN=your-jira-token \
  -e JIRA_EMAIL=your-email@company.com \
  -e JIRA_BASE_URL=https://company.atlassian.net \
  -- npx @bamboosoft/tempo-mcp
```

## Available Tools

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

If `accountKey` is not provided, it will be automatically fetched from the Jira issue.

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
