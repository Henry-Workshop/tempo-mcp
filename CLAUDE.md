# Tempo MCP - Instructions for Claude

This file contains instructions for Claude Code when users ask about timesheet management.

## Quick Reference

When a user asks to generate their timesheet, use the `tempo_generate_timesheet` tool.

### Common User Requests

| User says | What to do |
|-----------|------------|
| "fait ma feuille de temps" | Generate timesheet for current week |
| "do my timesheet" | Generate timesheet for current week |
| "timesheet for last week" | Generate timesheet for previous week |
| "show me what my timesheet would look like" | Use `dryRun: true` |

### How to Determine Parameters

1. **weekStart**: Calculate the Monday of the requested week
   - "this week" = Monday of current week
   - "last week" = Monday of previous week
   - User provides specific date = use that Monday

2. **gitAuthor**: Defaults to `JIRA_EMAIL` (same for all devs) - no need to specify

3. **projectsDir**: Defaults to `DEFAULT_PROJECTS_DIR` if configured - no need to specify

4. **dryRun**:
   - Default to `true` for first run to show user the plan
   - Set to `false` only when user confirms they want to create worklogs

5. **mondayMeetingIssue**: Default is `BS-14` (Monday team sync)

### Example Workflow

```
User: "fait ma feuille de temps de cette semaine"

1. Calculate Monday of current week:
   → 2025-12-01

2. Call with just weekStart (everything else uses defaults):
   tempo_generate_timesheet({
     weekStart: "2025-12-01"
   })

3. If user approves, run again with dryRun=false:
   tempo_generate_timesheet({
     weekStart: "2025-12-01",
     dryRun: false
   })
```

## Timesheet Rules (Bamboosoft)

- **Work days**: Monday to Thursday only (4 days)
- **Hours per day**: 8 hours
- **Daily sprint meeting**: 15 minutes on main project's "Sprint Meetings" issue
- **Monday team sync**: 15 minutes on BS-14 (talking about weekend)
- **Commit format**: Should include Jira issue key (e.g., `PROJ-123 fix: description`)

## Handling Edge Cases

### Commits without Jira issue keys
- Flag as warning in output
- Ask user which issue to assign them to

### No commits for a day
- Show warning that day has no entries
- Ask user if they worked on something not committed (meetings, reviews, etc.)

### Multiple projects same day
- Sprint meeting goes to the project with most commits that day
- Time is distributed proportionally based on commit count

## Troubleshooting

### "No git repositories found"
- Check that `projectsDir` path is correct
- Ensure repos have `.git` directory

### "No commits found for author"
- Verify git author email matches exactly
- Check date range is correct

### Account errors when creating worklogs
- The tool auto-fallbacks to active accounts
- If still failing, the issue might not have a valid Tempo account
