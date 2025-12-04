import { execSync } from "child_process";
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

const TEMPO_API_BASE = "https://api.tempo.io/4";

export interface TempoWorklog {
  tempoWorklogId: number;
  issue: {
    id: number;
    key?: string;
  };
  timeSpentSeconds: number;
  billableSeconds: number;
  startDate: string;
  startTime: string;
  description: string;
  author: {
    accountId: string;
  };
  attributes?: {
    values: Array<{
      key: string;
      value: string;
    }>;
  };
}

export interface WorkAttribute {
  key: string;
  name: string;
  type: string;
  required: boolean;
  values?: string[];
  names?: Record<string, string>;
}

export interface TempoRole {
  id: number;
  name: string;
  default: boolean;
}

export interface CreateWorklogParams {
  issueKey: string;
  timeSpentHours: number;
  date: string;
  description?: string;
  startTime?: string;
  role?: string;
  accountKey?: string;
}

export interface UpdateWorklogParams {
  worklogId: string;
  timeSpentHours: number;
  date?: string;
  description?: string;
  startTime?: string;
  role?: string;
  accountKey?: string;
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  issueKeys: string[];
  project: string;
}

export interface TimesheetDay {
  date: string;
  dayOfWeek: string;
  entries: TimesheetEntry[];
  totalHours: number;
}

export interface TimesheetEntry {
  issueKey: string;
  hours: number;
  description: string;
  project: string;
}

export interface GenerateTimesheetParams {
  weekStart: string; // Monday date YYYY-MM-DD
  gitAuthor: string; // Git author email or name
  projectsDir: string; // Directory containing git repos
  dryRun?: boolean; // If true, only return plan without creating worklogs
  mondayMeetingIssue?: string; // Issue for Monday meeting (default: BS-14)
}

export interface TimesheetResult {
  days: TimesheetDay[];
  worklogsCreated: number;
  errors: string[];
}

export class TempoClient {
  private tempoToken: string;
  private jiraToken: string;
  private jiraEmail: string;
  private jiraBaseUrl: string;
  private accountFieldId: string;
  private defaultRole: string;
  private roleAttributeKey: string | null = null;
  private accountAttributeKey: string | null = null;

  constructor(config: {
    tempoToken: string;
    jiraToken: string;
    jiraEmail: string;
    jiraBaseUrl: string;
    accountFieldId?: string;
    defaultRole?: string;
  }) {
    this.tempoToken = config.tempoToken;
    this.jiraToken = config.jiraToken;
    this.jiraEmail = config.jiraEmail;
    this.jiraBaseUrl = config.jiraBaseUrl.replace(/\/$/, "");
    this.accountFieldId = config.accountFieldId || "10026";
    this.defaultRole = config.defaultRole || "Dev";
  }

  private async tempoRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
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

    return response.json() as Promise<T>;
  }

  private async jiraRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const auth = Buffer.from(`${this.jiraEmail}:${this.jiraToken}`).toString(
      "base64"
    );
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

    return response.json() as Promise<T>;
  }

  async initialize(): Promise<void> {
    const attributes = await this.getWorkAttributes();
    for (const attr of attributes) {
      if (attr.type === "STATIC_LIST") {
        this.roleAttributeKey = attr.key;
      } else if (attr.type === "ACCOUNT") {
        this.accountAttributeKey = attr.key;
      }
    }
  }

  async getWorkAttributes(): Promise<WorkAttribute[]> {
    const response = await this.tempoRequest<{
      results: WorkAttribute[];
    }>("/work-attributes");
    return response.results;
  }

  async getRoles(): Promise<TempoRole[]> {
    const response = await this.tempoRequest<{
      results: TempoRole[];
    }>("/roles");
    return response.results;
  }

  async getIssueId(issueKey: string): Promise<number> {
    const issue = await this.jiraRequest<{ id: string }>(
      `/rest/api/2/issue/${issueKey}?fields=id`
    );
    return parseInt(issue.id, 10);
  }

  async getIssueAccount(issueKey: string): Promise<string | null> {
    const issue = await this.jiraRequest<{ fields: Record<string, unknown> }>(
      `/rest/api/2/issue/${issueKey}?fields=customfield_${this.accountFieldId}`
    );
    const accountField = issue.fields[`customfield_${this.accountFieldId}`];
    if (accountField && typeof accountField === "object") {
      const obj = accountField as Record<string, unknown>;
      if (typeof obj.value === "string") return obj.value;
      if (typeof obj.key === "string") return obj.key;
    }
    if (typeof accountField === "string") {
      return accountField;
    }
    return null;
  }

  async getCurrentUserAccountId(): Promise<string> {
    const user = await this.jiraRequest<{ accountId: string }>(
      "/rest/api/2/myself"
    );
    return user.accountId;
  }

  async getWorklogs(startDate: string, endDate: string): Promise<TempoWorklog[]> {
    const response = await this.tempoRequest<{
      results: TempoWorklog[];
    }>(`/worklogs?from=${startDate}&to=${endDate}`);
    return response.results;
  }

  async getWorklog(worklogId: string): Promise<TempoWorklog> {
    return this.tempoRequest<TempoWorklog>(`/worklogs/${worklogId}`);
  }
  async findSprintMeetingsIssue(projectKey: string): Promise<string | null> {
    const jql = encodeURIComponent(`project = ${projectKey} AND summary ~ "Sprint Meetings" ORDER BY created ASC`);
    const response = await this.jiraRequest<{ issues: Array<{ key: string }> }>(`/rest/api/3/search/jql?jql=${jql}&maxResults=1&fields=summary`);
    if (response.issues && response.issues.length > 0) {
      return response.issues[0].key;
    }
    return null;
  }

  async findActiveProjectAccount(projectKey: string, excludeAccount?: string): Promise<string | null> {
    const jql = encodeURIComponent(`project = ${projectKey} ORDER BY updated DESC`);
    const response = await this.jiraRequest<{ issues: Array<{ key: string; fields: Record<string, unknown> }> }>(
      `/rest/api/3/search/jql?jql=${jql}&maxResults=20&fields=customfield_${this.accountFieldId}`
    );
    if (response.issues) {
      for (const issue of response.issues) {
        const accountField = issue.fields[`customfield_${this.accountFieldId}`];
        let account: string | null = null;
        if (accountField && typeof accountField === "object") {
          const obj = accountField as Record<string, unknown>;
          if (typeof obj.value === "string") account = obj.value;
          else if (typeof obj.key === "string") account = obj.key;
        } else if (typeof accountField === "string") {
          account = accountField;
        }
        if (account && account !== excludeAccount) {
          return account;
        }
      }
    }
    return null;
  }



  async createWorklog(params: CreateWorklogParams): Promise<TempoWorklog> {
    await this.initialize();

    const issueId = await this.getIssueId(params.issueKey);
    const authorAccountId = await this.getCurrentUserAccountId();

    let accountKey = params.accountKey;
    if (!accountKey) {
      accountKey = await this.getIssueAccount(params.issueKey) || undefined;
    }

    const role = params.role || this.defaultRole;
    const projectKey = params.issueKey.split('-')[0];

    const tryCreateWorklog = async (account: string | undefined): Promise<TempoWorklog> => {
      const attributes: Array<{ key: string; value: string }> = [];

      if (this.roleAttributeKey) {
        attributes.push({ key: this.roleAttributeKey, value: role });
      }

      if (this.accountAttributeKey && account) {
        attributes.push({ key: this.accountAttributeKey, value: account });
      }

      const body: Record<string, unknown> = {
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

      return this.tempoRequest<TempoWorklog>("/worklogs", {
        method: "POST",
        body: JSON.stringify(body),
      });
    };

    try {
      return await tryCreateWorklog(accountKey);
    } catch (error) {
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

  async updateWorklog(params: UpdateWorklogParams): Promise<TempoWorklog> {
    await this.initialize();

    const existingWorklog = await this.getWorklog(params.worklogId);

    const role = params.role || this.defaultRole;

    const attributes: Array<{ key: string; value: string }> = [];

    if (this.roleAttributeKey) {
      attributes.push({ key: this.roleAttributeKey, value: role });
    }

    if (this.accountAttributeKey && params.accountKey) {
      attributes.push({ key: this.accountAttributeKey, value: params.accountKey });
    }

    const body: Record<string, unknown> = {
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

    return this.tempoRequest<TempoWorklog>(`/worklogs/${params.worklogId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteWorklog(worklogId: string): Promise<void> {
    await this.tempoRequest(`/worklogs/${worklogId}`, {
      method: "DELETE",
    });
  }

  /**
   * Scan a directory for git repositories
   */
  scanGitRepos(projectsDir: string): string[] {
    const repos: string[] = [];

    if (!existsSync(projectsDir)) {
      throw new Error(`Directory does not exist: ${projectsDir}`);
    }

    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const fullPath = join(projectsDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const gitDir = join(fullPath, ".git");
          if (existsSync(gitDir)) {
            repos.push(fullPath);
          }
        }
      } catch {
        // Skip entries we can't access
      }
    }

    return repos;
  }

  /**
   * Extract commits from a git repo for a specific date range and author
   */
  getGitCommits(
    repoPath: string,
    startDate: string,
    endDate: string,
    author: string
  ): GitCommit[] {
    const commits: GitCommit[] = [];
    const projectName = repoPath.split(/[/\\]/).pop() || "unknown";

    try {
      // Get commits with format: hash|date|message
      // Use %ad with --date=short for Windows compatibility (avoids %Y-%m-%d parsing issues)
      const cmd = `git log --after="${startDate}T00:00:00" --before="${endDate}T23:59:59" --author="${author}" --pretty=format:"%H|%ad|%s" --date=short --no-merges`;
      const output = execSync(cmd, {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (!output.trim()) {
        return commits;
      }

      const lines = output.trim().split("\n");
      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length >= 3) {
          const hash = parts[0];
          const date = parts[1];
          const message = parts.slice(2).join("|"); // In case message contains |

          // Extract Jira issue keys (pattern: ABC-123)
          const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
          const matches = message.match(issueKeyPattern) || [];
          const issueKeys = [...new Set(matches)]; // Remove duplicates

          commits.push({
            hash,
            date,
            message,
            issueKeys,
            project: projectName,
          });
        }
      }
    } catch {
      // Git command failed, skip this repo
    }

    return commits;
  }

  /**
   * Generate a client-friendly description from commit messages
   */
  private generateDescription(commits: GitCommit[]): string {
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
  async generateTimesheet(params: GenerateTimesheetParams): Promise<TimesheetResult> {
    const { weekStart, gitAuthor, projectsDir, dryRun = false, mondayMeetingIssue = "BS-14" } = params;

    const result: TimesheetResult = {
      days: [],
      worklogsCreated: 0,
      errors: [],
    };

    // Calculate the 4 days (Monday to Thursday)
    const startDate = new Date(weekStart);
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday"];
    const workDates: { date: string; dayOfWeek: string }[] = [];

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
    const allCommits: GitCommit[] = [];

    for (const repo of repos) {
      const commits = this.getGitCommits(repo, weekStart, weekEnd, gitAuthor);
      allCommits.push(...commits);
    }

    // Group commits by date
    const commitsByDate = new Map<string, GitCommit[]>();
    for (const commit of allCommits) {
      const existing = commitsByDate.get(commit.date) || [];
      existing.push(commit);
      commitsByDate.set(commit.date, existing);
    }

    // Process each day
    for (const { date, dayOfWeek } of workDates) {
      const dayCommits = commitsByDate.get(date) || [];
      const timesheetDay: TimesheetDay = {
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

        // Add BS-14 entry
        dayCommits.push({
          hash: "meeting",
          date,
          message: "Weekly team sync",
          issueKeys: [mondayMeetingIssue],
          project: mondayMeetingIssue.split("-")[0],
        });
      }

      if (dayCommits.length === 0) {
        // No commits for this day
        result.errors.push(`No commits found for ${dayOfWeek} (${date})`);
        result.days.push(timesheetDay);
        continue;
      }

      // Group commits by issue key
      const issueCommits = new Map<string, GitCommit[]>();
      const projectCounts = new Map<string, number>();

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

        // Count project occurrences for sprint meeting
        const count = projectCounts.get(commit.project) || 0;
        projectCounts.set(commit.project, count + 1);
      }

      // Determine the main project for sprint meeting
      let mainProject = "";
      let maxCount = 0;
      for (const [project, count] of projectCounts) {
        if (count > maxCount) {
          maxCount = count;
          mainProject = project;
        }
      }

      // Calculate hours per issue
      const issueKeys = [...issueCommits.keys()];
      if (issueKeys.length > 0) {
        // Calculate time per issue based on commit count weight
        const totalCommits = dayCommits.length;

        for (const issueKey of issueKeys) {
          const commits = issueCommits.get(issueKey) || [];
          const weight = commits.length / totalCommits;
          const minutes = Math.round(availableMinutes * weight);
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

        // Add sprint meeting to main project
        if (mainProject) {
          const sprintIssue = await this.findSprintMeetingsIssue(mainProject);
          if (sprintIssue) {
            timesheetDay.entries.push({
              issueKey: sprintIssue,
              hours: sprintMeetingMinutes / 60,
              description: "Daily standup",
              project: mainProject,
            });
            timesheetDay.totalHours += sprintMeetingMinutes / 60;
          }
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
          } catch (error) {
            result.errors.push(`Failed to create worklog for ${entry.issueKey} on ${date}: ${error}`);
          }
        }
      }
    }

    return result;
  }
}
