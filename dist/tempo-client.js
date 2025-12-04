"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TempoClient = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const TEMPO_API_BASE = "https://api.tempo.io/4";
class TempoClient {
    tempoToken;
    jiraToken;
    jiraEmail;
    jiraBaseUrl;
    accountFieldId;
    defaultRole;
    roleAttributeKey = null;
    accountAttributeKey = null;
    constructor(config) {
        this.tempoToken = config.tempoToken;
        this.jiraToken = config.jiraToken;
        this.jiraEmail = config.jiraEmail;
        this.jiraBaseUrl = config.jiraBaseUrl.replace(/\/$/, "");
        this.accountFieldId = config.accountFieldId || "10026";
        this.defaultRole = config.defaultRole || "Dev";
    }
    async tempoRequest(endpoint, options = {}) {
        const response = await fetch(`${TEMPO_API_BASE}${endpoint}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${this.tempoToken}`,
                "Content-Type": "application/json",
                ...options.headers,
            },
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Tempo API error (${response.status}): ${error}`);
        }
        return response.json();
    }
    async jiraRequest(endpoint, options = {}) {
        const auth = Buffer.from(`${this.jiraEmail}:${this.jiraToken}`).toString("base64");
        const response = await fetch(`${this.jiraBaseUrl}${endpoint}`, {
            ...options,
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/json",
                ...options.headers,
            },
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jira API error (${response.status}): ${error}`);
        }
        return response.json();
    }
    async initialize() {
        const attributes = await this.getWorkAttributes();
        for (const attr of attributes) {
            if (attr.type === "STATIC_LIST") {
                this.roleAttributeKey = attr.key;
            }
            else if (attr.type === "ACCOUNT") {
                this.accountAttributeKey = attr.key;
            }
        }
    }
    async getWorkAttributes() {
        const response = await this.tempoRequest("/work-attributes");
        return response.results;
    }
    async getRoles() {
        const response = await this.tempoRequest("/roles");
        return response.results;
    }
    async getIssueId(issueKey) {
        const issue = await this.jiraRequest(`/rest/api/2/issue/${issueKey}?fields=id`);
        return parseInt(issue.id, 10);
    }
    async getIssueAccount(issueKey) {
        const issue = await this.jiraRequest(`/rest/api/2/issue/${issueKey}?fields=customfield_${this.accountFieldId}`);
        const accountField = issue.fields[`customfield_${this.accountFieldId}`];
        if (accountField && typeof accountField === "object") {
            const obj = accountField;
            if (typeof obj.value === "string")
                return obj.value;
            if (typeof obj.key === "string")
                return obj.key;
        }
        if (typeof accountField === "string") {
            return accountField;
        }
        return null;
    }
    /**
     * Get story points and summary for a Jira issue
     * Story points field varies by Jira instance - common fields: customfield_10016, customfield_10026
     */
    async getIssueDetails(issueKey) {
        try {
            // Request common story point fields and summary
            const issue = await this.jiraRequest(`/rest/api/2/issue/${issueKey}?fields=summary,customfield_10016,customfield_10026,customfield_10004`);
            const summary = issue.fields.summary || "";
            // Try common story point field names
            let storyPoints = null;
            const possibleFields = ['customfield_10016', 'customfield_10026', 'customfield_10004'];
            for (const field of possibleFields) {
                const value = issue.fields[field];
                if (typeof value === 'number') {
                    storyPoints = value;
                    break;
                }
            }
            return { storyPoints, summary };
        }
        catch {
            return { storyPoints: null, summary: "" };
        }
    }
    async getCurrentUserAccountId() {
        const user = await this.jiraRequest("/rest/api/2/myself");
        return user.accountId;
    }
    async getWorklogs(startDate, endDate) {
        const response = await this.tempoRequest(`/worklogs?from=${startDate}&to=${endDate}`);
        return response.results;
    }
    async getWorklog(worklogId) {
        return this.tempoRequest(`/worklogs/${worklogId}`);
    }
    async findSprintMeetingsIssue(projectKey) {
        const jql = encodeURIComponent(`project = ${projectKey} AND summary ~ "Sprint Meetings" ORDER BY created ASC`);
        const response = await this.jiraRequest(`/rest/api/3/search/jql?jql=${jql}&maxResults=1&fields=summary`);
        if (response.issues && response.issues.length > 0) {
            return response.issues[0].key;
        }
        return null;
    }
    async findActiveProjectAccount(projectKey, excludeAccount) {
        const jql = encodeURIComponent(`project = ${projectKey} ORDER BY updated DESC`);
        const response = await this.jiraRequest(`/rest/api/3/search/jql?jql=${jql}&maxResults=20&fields=customfield_${this.accountFieldId}`);
        if (response.issues) {
            for (const issue of response.issues) {
                const accountField = issue.fields[`customfield_${this.accountFieldId}`];
                let account = null;
                if (accountField && typeof accountField === "object") {
                    const obj = accountField;
                    if (typeof obj.value === "string")
                        account = obj.value;
                    else if (typeof obj.key === "string")
                        account = obj.key;
                }
                else if (typeof accountField === "string") {
                    account = accountField;
                }
                if (account && account !== excludeAccount) {
                    return account;
                }
            }
        }
        return null;
    }
    async createWorklog(params) {
        await this.initialize();
        const issueId = await this.getIssueId(params.issueKey);
        const authorAccountId = await this.getCurrentUserAccountId();
        let accountKey = params.accountKey;
        if (!accountKey) {
            accountKey = await this.getIssueAccount(params.issueKey) || undefined;
        }
        const role = params.role || this.defaultRole;
        const projectKey = params.issueKey.split('-')[0];
        const tryCreateWorklog = async (account) => {
            const attributes = [];
            if (this.roleAttributeKey) {
                attributes.push({ key: this.roleAttributeKey, value: role });
            }
            if (this.accountAttributeKey && account) {
                attributes.push({ key: this.accountAttributeKey, value: account });
            }
            const body = {
                issueId,
                timeSpentSeconds: Math.round(params.timeSpentHours * 3600),
                startDate: params.date,
                description: params.description || "",
                authorAccountId,
            };
            if (params.startTime) {
                body.startTime = params.startTime;
            }
            if (attributes.length > 0) {
                body.attributes = attributes;
            }
            return this.tempoRequest("/worklogs", {
                method: "POST",
                body: JSON.stringify(body),
            });
        };
        try {
            return await tryCreateWorklog(accountKey);
        }
        catch (error) {
            const errorMsg = String(error);
            if (errorMsg.includes("Account not found") || errorMsg.includes("Account is closed or archived")) {
                const activeAccount = await this.findActiveProjectAccount(projectKey, accountKey);
                if (activeAccount && activeAccount !== accountKey) {
                    return await tryCreateWorklog(activeAccount);
                }
            }
            throw error;
        }
    }
    async updateWorklog(params) {
        await this.initialize();
        const existingWorklog = await this.getWorklog(params.worklogId);
        const role = params.role || this.defaultRole;
        const attributes = [];
        if (this.roleAttributeKey) {
            attributes.push({ key: this.roleAttributeKey, value: role });
        }
        if (this.accountAttributeKey && params.accountKey) {
            attributes.push({ key: this.accountAttributeKey, value: params.accountKey });
        }
        const body = {
            issueId: existingWorklog.issue.id,
            timeSpentSeconds: Math.round(params.timeSpentHours * 3600),
            startDate: params.date || existingWorklog.startDate,
            description: params.description ?? existingWorklog.description,
            authorAccountId: existingWorklog.author.accountId,
        };
        if (params.startTime) {
            body.startTime = params.startTime;
        }
        if (attributes.length > 0) {
            body.attributes = attributes;
        }
        return this.tempoRequest(`/worklogs/${params.worklogId}`, {
            method: "PUT",
            body: JSON.stringify(body),
        });
    }
    async deleteWorklog(worklogId) {
        await this.tempoRequest(`/worklogs/${worklogId}`, {
            method: "DELETE",
        });
    }
    /**
     * Scan a directory for git repositories
     */
    scanGitRepos(projectsDir) {
        const repos = [];
        if (!(0, fs_1.existsSync)(projectsDir)) {
            throw new Error(`Directory does not exist: ${projectsDir}`);
        }
        const entries = (0, fs_1.readdirSync)(projectsDir);
        for (const entry of entries) {
            const fullPath = (0, path_1.join)(projectsDir, entry);
            try {
                const stat = (0, fs_1.statSync)(fullPath);
                if (stat.isDirectory()) {
                    const gitDir = (0, path_1.join)(fullPath, ".git");
                    if ((0, fs_1.existsSync)(gitDir)) {
                        repos.push(fullPath);
                    }
                }
            }
            catch {
                // Skip entries we can't access
            }
        }
        return repos;
    }
    /**
     * Extract commits from a git repo for a specific date range and author
     */
    getGitCommits(repoPath, startDate, endDate, author) {
        const commits = [];
        const projectName = repoPath.split(/[/\\]/).pop() || "unknown";
        try {
            // Get commits with format: hash|date|message and include shortstat for lines changed
            // Use %ad with --date=short for Windows compatibility (avoids %Y-%m-%d parsing issues)
            const cmd = `git log --after="${startDate}T00:00:00" --before="${endDate}T23:59:59" --author="${author}" --pretty=format:"COMMIT|%H|%ad|%s" --date=short --shortstat --no-merges`;
            const output = (0, child_process_1.execSync)(cmd, {
                cwd: repoPath,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"]
            });
            if (!output.trim()) {
                return commits;
            }
            // Parse output - each commit has a COMMIT line followed by optional stat line
            const lines = output.trim().split("\n");
            let currentCommit = null;
            for (const line of lines) {
                if (line.startsWith("COMMIT|")) {
                    // Save previous commit if exists
                    if (currentCommit) {
                        const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
                        const matches = currentCommit.message.match(issueKeyPattern) || [];
                        const issueKeys = [...new Set(matches)];
                        commits.push({
                            ...currentCommit,
                            issueKeys,
                            project: projectName,
                            linesChanged: 10, // Default minimum if no stats
                        });
                    }
                    const parts = line.split("|");
                    if (parts.length >= 4) {
                        currentCommit = {
                            hash: parts[1],
                            date: parts[2],
                            message: parts.slice(3).join("|"),
                        };
                    }
                }
                else if (currentCommit && (line.includes("insertion") || line.includes("deletion"))) {
                    // Parse stat line: " 3 files changed, 45 insertions(+), 12 deletions(-)"
                    const insertions = line.match(/(\d+) insertion/);
                    const deletions = line.match(/(\d+) deletion/);
                    const linesChanged = (insertions ? parseInt(insertions[1]) : 0) + (deletions ? parseInt(deletions[1]) : 0);
                    const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
                    const matches = currentCommit.message.match(issueKeyPattern) || [];
                    const issueKeys = [...new Set(matches)];
                    commits.push({
                        hash: currentCommit.hash,
                        date: currentCommit.date,
                        message: currentCommit.message,
                        issueKeys,
                        project: projectName,
                        linesChanged: Math.max(linesChanged, 10), // Minimum 10 lines to avoid 0-weight commits
                    });
                    currentCommit = null;
                }
            }
            // Don't forget last commit if no stat line followed
            if (currentCommit) {
                const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
                const matches = currentCommit.message.match(issueKeyPattern) || [];
                const issueKeys = [...new Set(matches)];
                commits.push({
                    ...currentCommit,
                    issueKeys,
                    project: projectName,
                    linesChanged: 10,
                });
            }
        }
        catch {
            // Git command failed, skip this repo
        }
        return commits;
    }
    /**
     * Generate a client-friendly description from commit messages
     */
    generateDescription(commits) {
        // Group similar work and create a concise description
        const messages = commits.map(c => c.message);
        // Remove issue keys and common prefixes from messages
        const cleanMessages = messages.map(msg => {
            return msg
                .replace(/([A-Z][A-Z0-9]+-\d+)\s*[-:.]?\s*/g, "") // Remove issue keys
                .replace(/^(feat|fix|chore|docs|refactor|test|style)[\s:(]+/i, "") // Remove conventional commit prefixes
                .replace(/^\s*[-:]\s*/, "") // Remove leading dashes/colons
                .trim();
        }).filter(m => m.length > 0);
        if (cleanMessages.length === 0) {
            return "Development work";
        }
        // Take unique messages and join them
        const uniqueMessages = [...new Set(cleanMessages)];
        if (uniqueMessages.length === 1) {
            return uniqueMessages[0];
        }
        // Summarize if too many
        if (uniqueMessages.length > 3) {
            return uniqueMessages.slice(0, 3).join(", ") + "...";
        }
        return uniqueMessages.join(", ");
    }
    /**
     * Generate timesheet from git commits
     */
    async generateTimesheet(params) {
        const { weekStart, gitAuthor, projectsDir, dryRun = false, mondayMeetingIssue = "BS-14" } = params;
        const result = {
            days: [],
            worklogsCreated: 0,
            errors: [],
        };
        // Calculate the 4 days (Monday to Thursday)
        const startDate = new Date(weekStart);
        const days = ["Monday", "Tuesday", "Wednesday", "Thursday"];
        const workDates = [];
        for (let i = 0; i < 4; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            workDates.push({
                date: d.toISOString().split("T")[0],
                dayOfWeek: days[i],
            });
        }
        // Scan for git repos
        const repos = this.scanGitRepos(projectsDir);
        if (repos.length === 0) {
            result.errors.push(`No git repositories found in ${projectsDir}`);
            return result;
        }
        // Collect all commits for the week
        const weekEnd = workDates[3].date;
        const allCommits = [];
        for (const repo of repos) {
            const commits = this.getGitCommits(repo, weekStart, weekEnd, gitAuthor);
            allCommits.push(...commits);
        }
        // Group commits by date
        const commitsByDate = new Map();
        for (const commit of allCommits) {
            const existing = commitsByDate.get(commit.date) || [];
            existing.push(commit);
            commitsByDate.set(commit.date, existing);
        }
        // Process each day
        for (const { date, dayOfWeek } of workDates) {
            const dayCommits = commitsByDate.get(date) || [];
            const timesheetDay = {
                date,
                dayOfWeek,
                entries: [],
                totalHours: 0,
            };
            // Calculate available time (8h - meetings)
            let availableMinutes = 8 * 60; // 480 minutes
            // Daily sprint meeting (15 min) - will be added to main project
            const sprintMeetingMinutes = 15;
            availableMinutes -= sprintMeetingMinutes;
            // Monday: additional 15 min for BS-14
            if (dayOfWeek === "Monday") {
                const mondayMeetingMinutes = 15;
                availableMinutes -= mondayMeetingMinutes;
            }
            if (dayCommits.length === 0) {
                // No commits for this day
                result.errors.push(`No commits found for ${dayOfWeek} (${date})`);
                result.days.push(timesheetDay);
                continue;
            }
            // Group commits by issue key and track lines changed per project
            const issueCommits = new Map();
            const projectLines = new Map(); // Track total lines per project
            for (const commit of dayCommits) {
                if (commit.issueKeys.length === 0) {
                    // Commit without issue key - skip or add to generic
                    continue;
                }
                for (const key of commit.issueKeys) {
                    const existing = issueCommits.get(key) || [];
                    existing.push(commit);
                    issueCommits.set(key, existing);
                }
                // Track lines changed per project (use issue key prefix as project)
                const projectKey = commit.issueKeys[0]?.split("-")[0] || commit.project;
                const currentLines = projectLines.get(projectKey) || 0;
                projectLines.set(projectKey, currentLines + commit.linesChanged);
            }
            // Determine the main project for sprint meeting (based on lines changed)
            let mainProject = "";
            let maxLines = 0;
            for (const [project, lines] of projectLines) {
                if (lines > maxLines) {
                    maxLines = lines;
                    mainProject = project;
                }
            }
            // Calculate hours per issue based on lines changed and story points
            const issueKeys = [...issueCommits.keys()];
            if (issueKeys.length > 0) {
                // Fetch story points for all issues (in parallel for efficiency)
                const issueDetailsMap = new Map();
                await Promise.all(issueKeys.map(async (key) => {
                    const details = await this.getIssueDetails(key);
                    issueDetailsMap.set(key, details);
                }));
                // Calculate weighted score for each issue: linesChanged * storyPointMultiplier
                // Story points act as a multiplier (1 SP = base, 3 SP = 3x weight, etc.)
                const issueWeights = new Map();
                let totalWeight = 0;
                for (const issueKey of issueKeys) {
                    const commits = issueCommits.get(issueKey) || [];
                    const issueLines = commits.reduce((sum, c) => sum + c.linesChanged, 0);
                    const details = issueDetailsMap.get(issueKey);
                    // Use story points as multiplier (default to 1 if not set)
                    const storyPointMultiplier = details?.storyPoints || 1;
                    const weight = issueLines * storyPointMultiplier;
                    issueWeights.set(issueKey, weight);
                    totalWeight += weight;
                }
                for (const issueKey of issueKeys) {
                    const commits = issueCommits.get(issueKey) || [];
                    const weight = issueWeights.get(issueKey) || 0;
                    const weightRatio = weight / totalWeight;
                    const minutes = Math.round(availableMinutes * weightRatio);
                    const hours = Math.round((minutes / 60) * 100) / 100; // Round to 2 decimals
                    if (hours >= 0.25) { // Minimum 15 minutes
                        const description = this.generateDescription(commits);
                        timesheetDay.entries.push({
                            issueKey,
                            hours,
                            description,
                            project: issueKey.split("-")[0],
                        });
                        timesheetDay.totalHours += hours;
                    }
                }
                // Add daily standup to main project's Sprint Meetings issue
                if (mainProject) {
                    const sprintIssue = await this.findSprintMeetingsIssue(mainProject);
                    if (sprintIssue) {
                        timesheetDay.entries.push({
                            issueKey: sprintIssue,
                            hours: sprintMeetingMinutes / 60,
                            description: "Daily",
                            project: mainProject,
                        });
                        timesheetDay.totalHours += sprintMeetingMinutes / 60;
                    }
                }
                // Add Monday team sync (BS-14)
                if (dayOfWeek === "Monday") {
                    timesheetDay.entries.push({
                        issueKey: mondayMeetingIssue,
                        hours: 0.25, // 15 minutes
                        description: "Weekly team sync",
                        project: mondayMeetingIssue.split("-")[0],
                    });
                    timesheetDay.totalHours += 0.25;
                }
            }
            // Normalize to exactly 8 hours if needed
            if (timesheetDay.entries.length > 0 && Math.abs(timesheetDay.totalHours - 8) > 0.01) {
                const factor = 8 / timesheetDay.totalHours;
                for (const entry of timesheetDay.entries) {
                    entry.hours = Math.round(entry.hours * factor * 100) / 100;
                }
                timesheetDay.totalHours = timesheetDay.entries.reduce((sum, e) => sum + e.hours, 0);
            }
            result.days.push(timesheetDay);
            // Create worklogs if not dry run
            if (!dryRun) {
                for (const entry of timesheetDay.entries) {
                    try {
                        await this.createWorklog({
                            issueKey: entry.issueKey,
                            timeSpentHours: entry.hours,
                            date,
                            description: entry.description,
                        });
                        result.worklogsCreated++;
                    }
                    catch (error) {
                        result.errors.push(`Failed to create worklog for ${entry.issueKey} on ${date}: ${error}`);
                    }
                }
            }
        }
        return result;
    }
}
exports.TempoClient = TempoClient;
//# sourceMappingURL=tempo-client.js.map