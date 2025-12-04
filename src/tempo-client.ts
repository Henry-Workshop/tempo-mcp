import { execSync } from "child_process";
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import Imap from "imap";
import { simpleParser, ParsedMail } from "mailparser";

const TEMPO_API_BASE = "https://api.tempo.io/4";

export interface EmailMessage {
  date: string; // YYYY-MM-DD
  subject: string;
  from: string;
  to: string[];
  snippet: string; // First ~200 chars of body
  isSent: boolean;
}

export interface EmailTaskMatch {
  email: EmailMessage;
  issueKey: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

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
  linesChanged: number; // insertions + deletions
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
  private gmailUser: string | null = null;
  private gmailAppPassword: string | null = null;

  constructor(config: {
    tempoToken: string;
    jiraToken: string;
    jiraEmail: string;
    jiraBaseUrl: string;
    accountFieldId?: string;
    defaultRole?: string;
    gmailUser?: string;
    gmailAppPassword?: string;
  }) {
    this.tempoToken = config.tempoToken;
    this.jiraToken = config.jiraToken;
    this.jiraEmail = config.jiraEmail;
    this.jiraBaseUrl = config.jiraBaseUrl.replace(/\/$/, "");
    this.accountFieldId = config.accountFieldId || "10026";
    this.defaultRole = config.defaultRole || "Dev";
    this.gmailUser = config.gmailUser || null;
    this.gmailAppPassword = config.gmailAppPassword || null;
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

  /**
   * Get story points and summary for a Jira issue
   * Story points field varies by Jira instance - common fields: customfield_10016, customfield_10026
   */
  async getIssueDetails(issueKey: string): Promise<{ storyPoints: number | null; summary: string }> {
    try {
      // Request common story point fields and summary
      const issue = await this.jiraRequest<{ fields: Record<string, unknown> }>(
        `/rest/api/2/issue/${issueKey}?fields=summary,customfield_10016,customfield_10026,customfield_10004`
      );

      const summary = (issue.fields.summary as string) || "";

      // Try common story point field names
      let storyPoints: number | null = null;
      const possibleFields = ['customfield_10016', 'customfield_10026', 'customfield_10004'];

      for (const field of possibleFields) {
        const value = issue.fields[field];
        if (typeof value === 'number') {
          storyPoints = value;
          break;
        }
      }

      return { storyPoints, summary };
    } catch {
      return { storyPoints: null, summary: "" };
    }
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

  /**
   * Fetch emails from Gmail via IMAP for a date range
   */
  async getEmails(startDate: string, endDate: string): Promise<EmailMessage[]> {
    if (!this.gmailUser || !this.gmailAppPassword) {
      return []; // Gmail not configured
    }

    return new Promise((resolve, reject) => {
      const emails: EmailMessage[] = [];

      const imap = new Imap({
        user: this.gmailUser!,
        password: this.gmailAppPassword!,
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      });

      const fetchEmails = (boxName: string, isSent: boolean): Promise<EmailMessage[]> => {
        return new Promise((resolveBox, rejectBox) => {
          imap.openBox(boxName, true, (err, box) => {
            if (err) {
              resolveBox([]); // Box might not exist
              return;
            }

            // Search for emails in date range
            const searchCriteria = [
              ["SINCE", startDate],
              ["BEFORE", new Date(new Date(endDate).getTime() + 86400000).toISOString().split("T")[0]],
            ];

            imap.search(searchCriteria, (err, uids) => {
              if (err || !uids || uids.length === 0) {
                resolveBox([]);
                return;
              }

              const boxEmails: EmailMessage[] = [];
              const fetch = imap.fetch(uids, { bodies: "", struct: true });

              fetch.on("message", (msg) => {
                msg.on("body", (stream) => {
                  let buffer = "";
                  stream.on("data", (chunk) => {
                    buffer += chunk.toString("utf8");
                  });
                  stream.once("end", async () => {
                    try {
                      const parsed = await simpleParser(buffer);
                      const emailDate = parsed.date
                        ? parsed.date.toISOString().split("T")[0]
                        : startDate;

                      // Extract text snippet
                      let snippet = "";
                      if (parsed.text) {
                        snippet = parsed.text.substring(0, 300).replace(/\s+/g, " ").trim();
                      }

                      boxEmails.push({
                        date: emailDate,
                        subject: parsed.subject || "(No subject)",
                        from: parsed.from?.text || "",
                        to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text) : [parsed.to.text]) : [],
                        snippet,
                        isSent,
                      });
                    } catch {
                      // Skip unparseable emails
                    }
                  });
                });
              });

              fetch.once("error", () => resolveBox([]));
              fetch.once("end", () => resolveBox(boxEmails));
            });
          });
        });
      };

      imap.once("ready", async () => {
        try {
          // Fetch from INBOX (received) and [Gmail]/Sent Mail (sent)
          const received = await fetchEmails("INBOX", false);
          const sent = await fetchEmails("[Gmail]/Sent Mail", true);
          emails.push(...received, ...sent);
          imap.end();
          resolve(emails);
        } catch (e) {
          imap.end();
          resolve([]);
        }
      });

      imap.once("error", () => resolve([]));
      imap.once("end", () => {});

      imap.connect();
    });
  }

  /**
   * Match emails to Jira issues by searching for keywords
   */
  async matchEmailsToJiraIssues(emails: EmailMessage[]): Promise<EmailTaskMatch[]> {
    const matches: EmailTaskMatch[] = [];

    for (const email of emails) {
      // First, check if email subject/body contains a Jira issue key
      const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
      const subjectMatches = email.subject.match(issueKeyPattern);
      const bodyMatches = email.snippet.match(issueKeyPattern);

      if (subjectMatches && subjectMatches.length > 0) {
        matches.push({
          email,
          issueKey: subjectMatches[0],
          confidence: "high",
          reason: `Issue key found in subject: ${subjectMatches[0]}`,
        });
        continue;
      }

      if (bodyMatches && bodyMatches.length > 0) {
        matches.push({
          email,
          issueKey: bodyMatches[0],
          confidence: "medium",
          reason: `Issue key found in body: ${bodyMatches[0]}`,
        });
        continue;
      }

      // Search Jira for matching issues based on email content
      const searchTerms = email.subject.split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(" ");
      if (searchTerms) {
        try {
          const jql = encodeURIComponent(`text ~ "${searchTerms}" ORDER BY updated DESC`);
          const response = await this.jiraRequest<{ issues: Array<{ key: string; fields: { summary: string } }> }>(
            `/rest/api/3/search/jql?jql=${jql}&maxResults=1&fields=summary`
          );

          if (response.issues && response.issues.length > 0) {
            matches.push({
              email,
              issueKey: response.issues[0].key,
              confidence: "low",
              reason: `Jira search match: ${response.issues[0].fields.summary}`,
            });
            continue;
          }
        } catch {
          // Jira search failed, skip
        }
      }

      // No match found
      matches.push({
        email,
        issueKey: null,
        confidence: "low",
        reason: "No matching Jira issue found",
      });
    }

    return matches;
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
      // Get commits with format: hash|date|message and include shortstat for lines changed
      // Use %ad with --date=short for Windows compatibility (avoids %Y-%m-%d parsing issues)
      const cmd = `git log --after="${startDate}T00:00:00" --before="${endDate}T23:59:59" --author="${author}" --pretty=format:"COMMIT|%H|%ad|%s" --date=short --shortstat --no-merges`;
      const output = execSync(cmd, {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (!output.trim()) {
        return commits;
      }

      // Parse output - each commit has a COMMIT line followed by optional stat line
      const lines = output.trim().split("\n");
      let currentCommit: { hash: string; date: string; message: string } | null = null;

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
        } else if (currentCommit && (line.includes("insertion") || line.includes("deletion"))) {
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

    // Fetch and match emails (if Gmail is configured)
    const emailTasksByDate = new Map<string, EmailTaskMatch[]>();
    try {
      const emails = await this.getEmails(weekStart, weekEnd);
      if (emails.length > 0) {
        const matches = await this.matchEmailsToJiraIssues(emails);
        // Group by date and filter to only those with matched issues
        for (const match of matches) {
          if (match.issueKey && match.confidence !== "low") {
            const existing = emailTasksByDate.get(match.email.date) || [];
            existing.push(match);
            emailTasksByDate.set(match.email.date, existing);
          }
        }
      }
    } catch {
      // Gmail not configured or error, continue without emails
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
      }

      if (dayCommits.length === 0) {
        // No commits for this day
        result.errors.push(`No commits found for ${dayOfWeek} (${date})`);
        result.days.push(timesheetDay);
        continue;
      }

      // Group commits by issue key and track lines changed per project
      const issueCommits = new Map<string, GitCommit[]>();
      const projectLines = new Map<string, number>(); // Track total lines per project

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
        const issueDetailsMap = new Map<string, { storyPoints: number | null; summary: string }>();
        await Promise.all(
          issueKeys.map(async (key) => {
            const details = await this.getIssueDetails(key);
            issueDetailsMap.set(key, details);
          })
        );

        // Calculate weighted score for each issue: linesChanged * storyPointMultiplier
        // Story points act as a multiplier (1 SP = base, 3 SP = 3x weight, etc.)
        const issueWeights = new Map<string, number>();
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

        // Helper to round to nearest 0.25 (15 min blocks)
        const roundTo15Min = (h: number): number => Math.round(h * 4) / 4;

        for (const issueKey of issueKeys) {
          const weight = issueWeights.get(issueKey) || 0;
          const weightRatio = weight / totalWeight;
          const rawHours = (availableMinutes * weightRatio) / 60;
          // Round to 15 min blocks, minimum 0.25h (15 min) if there's any work
          const hours = Math.max(0.25, roundTo15Min(rawHours));

          // Use Jira summary as description
          const details = issueDetailsMap.get(issueKey);
          const description = details?.summary || issueKey;

          timesheetDay.entries.push({
            issueKey,
            hours,
            description,
            project: issueKey.split("-")[0],
          });
          timesheetDay.totalHours += hours;
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

      // Add email-based tasks (0.25h each, marked with 📧)
      const dayEmailTasks = emailTasksByDate.get(date) || [];
      const addedEmailIssues = new Set<string>();
      for (const emailTask of dayEmailTasks) {
        if (emailTask.issueKey && !addedEmailIssues.has(emailTask.issueKey)) {
          // Check if this issue is already in entries from commits
          const existingEntry = timesheetDay.entries.find(e => e.issueKey === emailTask.issueKey);
          if (!existingEntry) {
            // Fetch issue details for description
            const details = await this.getIssueDetails(emailTask.issueKey);
            timesheetDay.entries.push({
              issueKey: emailTask.issueKey,
              hours: 0.25, // Minimum 15 min for email tasks
              description: `📧 ${details?.summary || emailTask.email.subject}`,
              project: emailTask.issueKey.split("-")[0],
            });
            timesheetDay.totalHours += 0.25;
            addedEmailIssues.add(emailTask.issueKey);
          }
        }
      }

      // Normalize to exactly 8 hours in 15-min blocks
      if (timesheetDay.entries.length > 0) {
        const roundTo15Min = (h: number): number => Math.round(h * 4) / 4;
        const targetHours = 8;

        // First pass: scale and round to 15-min blocks
        const factor = targetHours / timesheetDay.totalHours;
        for (const entry of timesheetDay.entries) {
          entry.hours = Math.max(0.25, roundTo15Min(entry.hours * factor));
        }

        // Calculate difference and adjust largest entry to hit exactly 8h
        let currentTotal = timesheetDay.entries.reduce((sum, e) => sum + e.hours, 0);
        const diff = roundTo15Min(targetHours - currentTotal);

        if (Math.abs(diff) >= 0.25) {
          // Find the largest non-meeting entry to adjust
          const adjustableEntries = timesheetDay.entries.filter(e => !e.description.includes("Daily") && !e.description.includes("team sync"));
          if (adjustableEntries.length > 0) {
            const largest = adjustableEntries.reduce((a, b) => a.hours > b.hours ? a : b);
            largest.hours = Math.max(0.25, roundTo15Min(largest.hours + diff));
          }
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
