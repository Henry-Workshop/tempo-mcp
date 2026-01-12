import { execSync } from "child_process";
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as http from "http";
import * as url from "url";
import open from "open";

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

export interface CalendarEvent {
  date: string; // YYYY-MM-DD
  title: string;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  durationMinutes: number;
  attendees: string[];
  description?: string;
}

export interface CalendarTaskMatch {
  event: CalendarEvent;
  issueKey: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface JiraProject {
  key: string;
  name: string;
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
  private gmailOAuth: OAuth2Client | null = null;
  private gmailTokenPath: string | null = null;
  private cachedProjects: JiraProject[] | null = null;
  public lastCalendarDebug: string = "";

  constructor(config: {
    tempoToken: string;
    jiraToken: string;
    jiraEmail: string;
    jiraBaseUrl: string;
    accountFieldId?: string;
    defaultRole?: string;
    gmailClientId?: string;
    gmailClientSecret?: string;
    gmailTokenPath?: string;
  }) {
    this.tempoToken = config.tempoToken;
    this.jiraToken = config.jiraToken;
    this.jiraEmail = config.jiraEmail;
    this.jiraBaseUrl = config.jiraBaseUrl.replace(/\/$/, "");
    this.accountFieldId = config.accountFieldId || "10026";
    this.defaultRole = config.defaultRole || "Dev";

    // Setup Gmail OAuth if credentials provided
    if (config.gmailClientId && config.gmailClientSecret) {
      this.gmailOAuth = new google.auth.OAuth2(
        config.gmailClientId,
        config.gmailClientSecret,
        "http://localhost:3000/oauth2callback"
      );
      this.gmailTokenPath = config.gmailTokenPath || join(process.env.HOME || process.env.USERPROFILE || ".", ".tempo-gmail-token.json");

      // Load existing token if available
      if (existsSync(this.gmailTokenPath)) {
        try {
          const token = JSON.parse(readFileSync(this.gmailTokenPath, "utf8"));
          this.gmailOAuth.setCredentials(token);
        } catch {
          // Token file invalid, will need to re-auth
        }
      }
    }
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
   * Check if Gmail OAuth is configured and authenticated
   */
  isGmailConfigured(): boolean {
    return this.gmailOAuth !== null && this.gmailOAuth.credentials?.access_token !== undefined;
  }

  /**
   * Get Gmail OAuth URL for user to authorize
   */
  getGmailAuthUrl(): string | null {
    if (!this.gmailOAuth) return null;

    return this.gmailOAuth.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly"
      ],
      prompt: "consent",
    });
  }

  /**
   * Authenticate Gmail via OAuth - starts local server to receive callback
   */
  async authenticateGmail(): Promise<boolean> {
    if (!this.gmailOAuth) {
      throw new Error("Gmail OAuth not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.");
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new url.URL(req.url!, `http://localhost:3000`);
          if (reqUrl.pathname === "/oauth2callback") {
            const code = reqUrl.searchParams.get("code");
            if (code) {
              const { tokens } = await this.gmailOAuth!.getToken(code);
              this.gmailOAuth!.setCredentials(tokens);

              // Save token for future use
              if (this.gmailTokenPath) {
                writeFileSync(this.gmailTokenPath, JSON.stringify(tokens));
              }

              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<h1>Authentication successful!</h1><p>You can close this window.</p>");
              server.close();
              resolve(true);
            } else {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Authentication failed</h1><p>No code received.</p>");
              server.close();
              resolve(false);
            }
          }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><p>${e}</p>`);
          server.close();
          reject(e);
        }
      });

      server.listen(3000, async () => {
        const authUrl = this.getGmailAuthUrl();
        console.log(`\n🔐 Opening browser for Gmail authorization...\n`);
        if (authUrl) {
          await open(authUrl);
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error("Authentication timeout"));
      }, 300000);
    });
  }

  /**
   * Fetch emails from Gmail via API for a date range
   */
  async getEmails(startDate: string, endDate: string): Promise<EmailMessage[]> {
    if (!this.gmailOAuth || !this.gmailOAuth.credentials?.access_token) {
      return []; // Gmail not configured or not authenticated
    }

    const emails: EmailMessage[] = [];
    const gmail = google.gmail({ version: "v1", auth: this.gmailOAuth });

    try {
      // Format dates for Gmail query (YYYY/MM/DD)
      const afterDate = startDate.replace(/-/g, "/");
      const beforeDate = new Date(new Date(endDate).getTime() + 86400000).toISOString().split("T")[0].replace(/-/g, "/");

      // Search for emails in date range (both sent and received)
      const queries = [
        `after:${afterDate} before:${beforeDate} in:inbox`,
        `after:${afterDate} before:${beforeDate} in:sent`,
      ];

      for (const query of queries) {
        const isSent = query.includes("in:sent");
        const response = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: 100,
        });

        if (response.data.messages) {
          for (const msg of response.data.messages) {
            try {
              const fullMsg = await gmail.users.messages.get({
                userId: "me",
                id: msg.id!,
                format: "full",
              });

              const headers = fullMsg.data.payload?.headers || [];
              const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

              // Parse date
              const dateHeader = getHeader("Date");
              let emailDate = startDate;
              if (dateHeader) {
                try {
                  emailDate = new Date(dateHeader).toISOString().split("T")[0];
                } catch {
                  // Keep default
                }
              }

              // Get snippet
              const snippet = fullMsg.data.snippet || "";

              emails.push({
                date: emailDate,
                subject: getHeader("Subject") || "(No subject)",
                from: getHeader("From"),
                to: getHeader("To").split(",").map((t) => t.trim()),
                snippet: snippet.substring(0, 300),
                isSent,
              });
            } catch {
              // Skip individual message errors
            }
          }
        }
      }
    } catch (e) {
      // Gmail API error, return empty
      console.error("Gmail API error:", e);
    }

    return emails;
  }

  /**
   * Fetch calendar events from Google Calendar for a date range
   * Only includes events where user is attending (accepted or tentative)
   */
  async getCalendarEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    console.error(`[Calendar] getCalendarEvents called for ${startDate} to ${endDate}`);

    if (!this.gmailOAuth) {
      console.error("[Calendar] gmailOAuth is null");
      return [];
    }
    if (!this.gmailOAuth.credentials) {
      console.error("[Calendar] gmailOAuth.credentials is null");
      return [];
    }
    if (!this.gmailOAuth.credentials.access_token) {
      console.error("[Calendar] access_token is null");
      return [];
    }

    console.error("[Calendar] OAuth is configured, fetching events...");

    const events: CalendarEvent[] = [];
    const calendar = google.calendar({ version: "v3", auth: this.gmailOAuth });

    try {
      const timeMin = new Date(startDate + "T00:00:00").toISOString();
      const timeMax = new Date(endDate + "T23:59:59").toISOString();
      console.error(`[Calendar] Query: timeMin=${timeMin}, timeMax=${timeMax}`);

      // Get events from primary calendar
      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
      });

      const rawCount = response.data.items?.length || 0;
      console.error(`[Calendar] API returned ${rawCount} raw events`);

      let skippedAllDay = 0;
      let skippedDeclined = 0;

      if (response.data.items) {
        for (const event of response.data.items) {
          // Skip all-day events (no specific time)
          if (!event.start?.dateTime || !event.end?.dateTime) {
            skippedAllDay++;
            continue;
          }

          // Skip declined events
          const myAttendee = event.attendees?.find(a => a.self);
          if (myAttendee?.responseStatus === "declined") {
            skippedDeclined++;
            continue;
          }

          const startTime = new Date(event.start.dateTime);
          const endTime = new Date(event.end.dateTime);
          const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000);

          // Round duration to 15-min blocks (minimum 15 min)
          const roundedDuration = Math.max(15, Math.round(durationMinutes / 15) * 15);

          events.push({
            date: startTime.toISOString().split("T")[0],
            title: event.summary || "(No title)",
            startTime: startTime.toTimeString().substring(0, 5), // HH:MM
            endTime: endTime.toTimeString().substring(0, 5),
            durationMinutes: roundedDuration,
            attendees: (event.attendees || []).map(a => a.email || "").filter(e => e),
            description: event.description || undefined,
          });

          console.error(`[Calendar] Added event: "${event.summary}" on ${startTime.toISOString().split("T")[0]}`);
        }
      }

      console.error(`[Calendar] Skipped ${skippedAllDay} all-day, ${skippedDeclined} declined`);
      this.lastCalendarDebug = `raw=${rawCount},allday=${skippedAllDay},declined=${skippedDeclined},kept=${events.length}`;
    } catch (e: any) {
      console.error("[Calendar] API error:", e.message || e);
      this.lastCalendarDebug = `error: ${e.message || e}`;
      if (e.response?.data) {
        console.error("[Calendar] Error details:", JSON.stringify(e.response.data));
      }
    }

    console.error(`[Calendar] Final: ${events.length} events for ${startDate} to ${endDate}`);
    return events;
  }

  /**
   * Match calendar events to Jira issues using AI-like similarity reasoning
   */
  async matchCalendarEventsToJiraIssues(events: CalendarEvent[]): Promise<CalendarTaskMatch[]> {
    const matches: CalendarTaskMatch[] = [];
    if (events.length === 0) return matches;

    // Get all sprint issues once (cached for all events)
    const sprintIssues = await this.getAllSprintIssues();

    for (const event of events) {
      // First, check if event title contains a Jira issue key
      const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
      const titleMatches = event.title.match(issueKeyPattern);
      const descMatches = event.description?.match(issueKeyPattern);

      if (titleMatches && titleMatches.length > 0) {
        matches.push({
          event,
          issueKey: titleMatches[0],
          confidence: "high",
          reason: `Issue key in title: ${titleMatches[0]}`,
        });
        continue;
      }

      if (descMatches && descMatches.length > 0) {
        matches.push({
          event,
          issueKey: descMatches[0],
          confidence: "medium",
          reason: `Issue key in description: ${descMatches[0]}`,
        });
        continue;
      }

      // AI-like matching: find the best matching issue based on similarity
      // Check if any attendee's email domain matches a project
      let matchedProject: JiraProject | null = null;
      for (const attendee of event.attendees) {
        const domainMatch = attendee.match(/@([^.]+)/);
        if (domainMatch) {
          const companyName = domainMatch[1].toLowerCase();
          matchedProject = await this.findProjectByCompany(companyName);
          if (matchedProject) break;
        }
      }

      // Extract keywords from event title and description
      const eventText = event.title + ' ' + (event.description || '');
      const eventKeywords = this.extractKeywords(eventText);
      if (eventKeywords.length === 0) continue;

      // Find best matching issue
      let bestMatch: { key: string; score: number; reason: string } | null = null;

      for (const issue of sprintIssues) {
        // If we matched a project from attendee, prioritize issues from that project
        const projectBonus = matchedProject && issue.project === matchedProject.key ? 0.3 : 0;

        const issueKeywords = this.extractKeywords(issue.summary);
        const similarity = this.calculateSimilarity(eventKeywords, issueKeywords);
        const totalScore = similarity + projectBonus;

        if (totalScore > 0.3 && (!bestMatch || totalScore > bestMatch.score)) {
          bestMatch = {
            key: issue.key,
            score: totalScore,
            reason: `Similarity: ${(similarity * 100).toFixed(0)}%${projectBonus ? ` + attendee project match (${matchedProject?.name})` : ''} → "${issue.summary.substring(0, 50)}"`,
          };
        }
      }

      if (bestMatch) {
        matches.push({
          event,
          issueKey: bestMatch.key,
          confidence: bestMatch.score > 0.5 ? "high" : "medium",
          reason: bestMatch.reason,
        });
      }
    }

    return matches;
  }

  /**
   * Get all Jira projects (cached)
   */
  async getAllJiraProjects(): Promise<JiraProject[]> {
    if (this.cachedProjects) {
      return this.cachedProjects;
    }

    try {
      const response = await this.jiraRequest<Array<{ key: string; name: string }>>(
        "/rest/api/2/project"
      );
      this.cachedProjects = response.map(p => ({ key: p.key, name: p.name }));
      return this.cachedProjects;
    } catch {
      return [];
    }
  }

  /**
   * Extract company name from email recipient
   * Handles formats like: "John Doe <john@company.com>", "john@company.com"
   */
  private extractCompanyFromEmail(email: EmailMessage): string | null {
    if (!email.isSent || email.to.length === 0) {
      return null;
    }

    // Get the first recipient
    const recipient = email.to[0];

    // Extract email address from "Name <email>" format
    const emailMatch = recipient.match(/<([^>]+)>/) || [null, recipient];
    const emailAddr = emailMatch[1] || recipient;

    // Extract domain
    const domainMatch = emailAddr.match(/@([^.]+)/);
    if (!domainMatch) return null;

    // Return the company name (first part of domain, lowercase)
    return domainMatch[1].toLowerCase();
  }

  /**
   * Find Jira project by company name using fuzzy matching
   */
  private async findProjectByCompany(companyName: string): Promise<JiraProject | null> {
    const projects = await this.getAllJiraProjects();
    const searchName = companyName.toLowerCase();

    // First: exact match on project key
    const exactKeyMatch = projects.find(p => p.key.toLowerCase() === searchName);
    if (exactKeyMatch) return exactKeyMatch;

    // Second: project name contains company name
    const nameContains = projects.find(p => p.name.toLowerCase().includes(searchName));
    if (nameContains) return nameContains;

    // Third: project name (without spaces) matches company name
    // e.g., "laurinlaurin" matches "Laurin Laurin"
    const nameNoSpaces = projects.find(p =>
      p.name.toLowerCase().replace(/\s+/g, '').includes(searchName) ||
      searchName.includes(p.name.toLowerCase().replace(/\s+/g, ''))
    );
    if (nameNoSpaces) return nameNoSpaces;

    // Fourth: company name contains project key (for abbreviations)
    const keyInCompany = projects.find(p => searchName.includes(p.key.toLowerCase()));
    if (keyInCompany) return keyInCompany;

    // Fifth: any word from project name is in company name
    const wordMatch = projects.find(p => {
      const projectWords = p.name.toLowerCase().split(/\s+/);
      return projectWords.some(word => word.length > 3 && searchName.includes(word));
    });
    if (wordMatch) return wordMatch;

    // Sixth: fuzzy match - company name starts with similar letters as project
    const fuzzyMatch = projects.find(p => {
      const projectWords = p.name.toLowerCase().split(/\s+/);
      return projectWords.some(word => word.startsWith(searchName.substring(0, 3)));
    });
    if (fuzzyMatch) return fuzzyMatch;

    return null;
  }

  /**
   * Search for Jira issues in a project's current sprint matching search terms
   * Prioritizes: 1) current sprint, 2) recent issues (30 days)
   */
  private async searchIssuesInProject(projectKey: string, searchTerms: string): Promise<string | null> {
    // First: try to find in current sprint (most relevant for timesheet)
    try {
      const sprintJql = encodeURIComponent(
        `project = ${projectKey} AND sprint in openSprints() AND text ~ "${searchTerms}" ORDER BY updated DESC`
      );
      const sprintResponse = await this.jiraRequest<{ issues: Array<{ key: string; fields: { summary: string } }> }>(
        `/rest/api/3/search/jql?jql=${sprintJql}&maxResults=1&fields=summary`
      );

      if (sprintResponse.issues && sprintResponse.issues.length > 0) {
        return sprintResponse.issues[0].key;
      }
    } catch {
      // Sprint search failed, try without sprint filter
    }

    // Second: try recent issues in project (last 30 days)
    try {
      const recentJql = encodeURIComponent(
        `project = ${projectKey} AND updated >= -30d AND text ~ "${searchTerms}" ORDER BY updated DESC`
      );
      const recentResponse = await this.jiraRequest<{ issues: Array<{ key: string; fields: { summary: string } }> }>(
        `/rest/api/3/search/jql?jql=${recentJql}&maxResults=1&fields=summary`
      );

      if (recentResponse.issues && recentResponse.issues.length > 0) {
        return recentResponse.issues[0].key;
      }
    } catch {
      // Search failed
    }

    return null;
  }

  /**
   * Extract keywords from text for similarity matching
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      're', 'fwd', 'fw', 'the', 'and', 'for', 'from', 'with', 'about', 'this', 'that',
      'have', 'has', 'had', 'been', 'will', 'would', 'could', 'should', 'can', 'may',
      'une', 'des', 'les', 'pour', 'dans', 'sur', 'avec', 'est', 'sont', 'qui', 'que',
      'vous', 'nous', 'votre', 'notre', 'merci', 'bonjour', 'salut', 'cordialement'
    ]);

    return text
      .toLowerCase()
      .split(/[\s:,\-\[\]\(\)\/\\'"!?.]+/)
      .filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w));
  }

  /**
   * Calculate similarity score between two sets of keywords (0-1)
   */
  private calculateSimilarity(keywords1: string[], keywords2: string[]): number {
    if (keywords1.length === 0 || keywords2.length === 0) return 0;

    const set1 = new Set(keywords1);
    const set2 = new Set(keywords2);

    let matches = 0;
    for (const word of set1) {
      if (set2.has(word)) {
        matches++;
      } else {
        // Partial match (one contains the other)
        for (const word2 of set2) {
          if (word.includes(word2) || word2.includes(word)) {
            matches += 0.5;
            break;
          }
        }
      }
    }

    // Normalize by the smaller set size
    return matches / Math.min(set1.size, set2.size);
  }

  /**
   * Get all issues from current sprints across all projects
   */
  private async getAllSprintIssues(): Promise<Array<{ key: string; summary: string; project: string }>> {
    try {
      const jql = encodeURIComponent(`sprint in openSprints() ORDER BY updated DESC`);
      const response = await this.jiraRequest<{
        issues: Array<{ key: string; fields: { summary: string; project: { key: string } } }>
      }>(`/rest/api/3/search/jql?jql=${jql}&maxResults=200&fields=summary,project`);

      return (response.issues || []).map(issue => ({
        key: issue.key,
        summary: issue.fields.summary,
        project: issue.fields.project.key,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Match SENT emails to Jira issues using AI-like similarity reasoning:
   * 1. Check for explicit Jira issue keys in email
   * 2. Match recipient company to project
   * 3. Calculate keyword similarity between email and all sprint issues
   * 4. Return best match if score is high enough
   */
  async matchEmailsToJiraIssues(emails: EmailMessage[]): Promise<EmailTaskMatch[]> {
    const matches: EmailTaskMatch[] = [];

    // Only process SENT emails - these represent work done for clients
    const sentEmails = emails.filter(e => e.isSent);
    if (sentEmails.length === 0) return matches;

    // Get all sprint issues once (cached for all emails)
    const sprintIssues = await this.getAllSprintIssues();

    for (const email of sentEmails) {
      // First, check if email subject/body contains a Jira issue key
      const issueKeyPattern = /([A-Z][A-Z0-9]+-\d+)/g;
      const subjectMatches = email.subject.match(issueKeyPattern);
      const bodyMatches = email.snippet.match(issueKeyPattern);

      if (subjectMatches && subjectMatches.length > 0) {
        matches.push({
          email,
          issueKey: subjectMatches[0],
          confidence: "high",
          reason: `Issue key in subject: ${subjectMatches[0]}`,
        });
        continue;
      }

      if (bodyMatches && bodyMatches.length > 0) {
        matches.push({
          email,
          issueKey: bodyMatches[0],
          confidence: "medium",
          reason: `Issue key in body: ${bodyMatches[0]}`,
        });
        continue;
      }

      // AI-like matching: find the best matching issue based on similarity
      const companyName = this.extractCompanyFromEmail(email);
      const matchedProject = companyName ? await this.findProjectByCompany(companyName) : null;

      // Extract keywords from email content
      const emailKeywords = this.extractKeywords(email.subject + ' ' + email.snippet);
      if (emailKeywords.length === 0) continue;

      // Find best matching issue
      let bestMatch: { key: string; score: number; reason: string } | null = null;

      for (const issue of sprintIssues) {
        // If we matched a project from email recipient, prioritize issues from that project
        const projectBonus = matchedProject && issue.project === matchedProject.key ? 0.3 : 0;

        const issueKeywords = this.extractKeywords(issue.summary);
        const similarity = this.calculateSimilarity(emailKeywords, issueKeywords);
        const totalScore = similarity + projectBonus;

        if (totalScore > 0.3 && (!bestMatch || totalScore > bestMatch.score)) {
          bestMatch = {
            key: issue.key,
            score: totalScore,
            reason: `Similarity: ${(similarity * 100).toFixed(0)}%${projectBonus ? ` + project match (${matchedProject?.name})` : ''} → "${issue.summary.substring(0, 50)}"`,
          };
        }
      }

      if (bestMatch) {
        matches.push({
          email,
          issueKey: bestMatch.key,
          confidence: bestMatch.score > 0.5 ? "high" : "medium",
          reason: bestMatch.reason,
        });
      }
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
  private simplifyTechnical(text: string): string {
    let result = text
      // Remove technical suffixes/details
      .replace(/\s*(dans|in|from|to)\s*(la\s*)?(bd|db|database|base de données)\b/gi, "")
      .replace(/\s*taille\s*(dans|de)?\s*/gi, " ")
      .replace(/\s*size\s*(in|of)?\s*/gi, " ")
      // Simplify camelCase/snake_case to readable words
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      // Remove overly technical terms
      .replace(/\b(workorder|order)\s*references?\b/gi, "commandes")
      .replace(/\binvoice\b/gi, "facture")
      .replace(/\bapi\b/gi, "")
      .replace(/\bauth0?\b/gi, "authentification")
      .replace(/\b(staging|prod|production)\b/gi, "")
      .replace(/\b(component|module|class|function|method)\b/gi, "")
      .replace(/\b(endpoint|route|controller)\b/gi, "")
      .replace(/\b(field|column|table|row)\b/gi, "")
      .replace(/\bglobaux\b/gi, "généraux")
      // Clean up extra spaces
      .replace(/\s+/g, " ")
      .trim();
    return result;
  }

    private translateToFrench(text: string): string {
    const translations: [RegExp, string][] = [
      [/\bfix(ed|ing|es)?\b/gi, "Correctif"],
      [/\badd(ed|ing|s)?\b/gi, "Ajout"],
      [/\bremove(d|s)?\b/gi, "Suppression"],
      [/\bupdate(d|s)?\b/gi, "Mise à jour"],
      [/\brefactor(ed|ing)?\b/gi, "Refactorisation"],
      [/\bclean(ed|ing|up)?\b/gi, "Nettoyage"],
      [/\bput back\b/gi, "Remise en place"],
      [/\brounding\b/gi, "arrondissement"],
      [/\blogs?\b/gi, "journaux"],
      [/\bscripts?\b/gi, "scripts"],
      [/\bplace freed\b/gi, "place libérée"],
      [/\bsize\b/gi, "taille"],
      [/\bchange(d|s)?\b/gi, "Modification"],
      [/\bcreate(d|s)?\b/gi, "Création"],
      [/\bdelete(d|s)?\b/gi, "Suppression"],
      [/\bimplement(ed|s)?\b/gi, "Implémentation"],
      [/\bimprove(d|s)?\b/gi, "Amélioration"],
      [/\bmerge(d|s)?\b/gi, "Fusion"],
      [/\bmove(d|s)?\b/gi, "Déplacement"],
      [/\brename(d|s)?\b/gi, "Renommage"],
      [/\btest(s|ing)?\b/gi, "Test"],
      [/\bdebug(ging)?\b/gi, "Débogage"],
      [/\band\b/gi, "et"],
      [/\bfor\b/gi, "pour"],
      [/\bwith\b/gi, "avec"],
      [/\bin\b/gi, "dans"],
    ];

    let result = text;
    for (const [pattern, replacement] of translations) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  private generateDescription(commits: GitCommit[]): string {
    const messages = commits.map(c => c.message);

    const cleanMessages = messages.map(msg => {
      return msg
        .replace(/([A-Z][A-Z0-9]+-\d+)\s*[-:.]?\s*/g, "")
        .replace(/^(feat|fix|chore|docs|refactor|test|style)[\s:(]+/i, "")
        .replace(/^\s*[-:]\s*/, "")
        .trim();
    }).filter(m => m.length > 0);

    if (cleanMessages.length === 0) return "Développement";

    // Get unique summaries, translate to French
    const uniqueSummaries = [...new Set(cleanMessages.map(m => {
      const simplified = this.simplifyTechnical(m);
      const translated = this.translateToFrench(simplified);
      const summary = translated.charAt(0).toUpperCase() + translated.slice(1);
      return summary.length > 60 ? summary.substring(0, 57) + "..." : summary;
    }))];

    // Take up to 3 summaries, join with " | "
    const description = uniqueSummaries.slice(0, 3).join(" | ");

    // Truncate total to 150 chars max
    return description.length > 150 ? description.substring(0, 147) + "..." : description;
  }

  /**
   * Simplify email subject into client-friendly description
   */
  private simplifyEmailSubject(subject: string): string {
    let clean = subject
      .replace(/^(re|fwd|fw|tr):\s*/gi, "")
      .replace(/^(re|fwd|fw|tr):\s*/gi, "")
      .trim();
    const parts = clean.split(/[-–—:]/);
    if (parts.length > 1) clean = parts[0].trim();
    if (clean.length > 0) clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    if (clean.length > 35) clean = clean.substring(0, 32) + "...";
    return clean || "Suivi client";
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

    // Fetch and match calendar events (if Google OAuth is configured)
    const calendarTasksByDate = new Map<string, CalendarTaskMatch[]>();
    try {
      const events = await this.getCalendarEvents(weekStart, weekEnd);
      if (events.length > 0) {
        const matches = await this.matchCalendarEventsToJiraIssues(events);
        // Group by date and filter to only those with matched issues
        for (const match of matches) {
          if (match.issueKey && match.confidence !== "low") {
            const existing = calendarTasksByDate.get(match.event.date) || [];
            existing.push(match);
            calendarTasksByDate.set(match.event.date, existing);
          }
        }
      }
    } catch {
      // Calendar not configured or error, continue without calendar events
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
      // Meeting times now from calendar
      // Deducted based on actual calendar events

      // Monday: additional 15 min for BS-14
      if (dayOfWeek === "Monday") {
        const mondayMeetingMinutes = 15;
        availableMinutes -= mondayMeetingMinutes;
      }

      if (dayCommits.length === 0) {
        // No commits for this day
        result.errors.push(`No commits found for ${dayOfWeek} (${date})`);
        
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

          // Generate description from commit messages (more precise than Jira summary)
          const commits = issueCommits.get(issueKey) || [];
          const description = this.generateDescription(commits);

          timesheetDay.entries.push({
            issueKey,
            hours,
            description,
            project: issueKey.split("-")[0],
          });
          timesheetDay.totalHours += hours;
        }

        // Sprint meetings detected from calendar below
      }

      // Add sprint/project meetings from calendar
      const oauthStatus = !this.gmailOAuth ? "no-oauth" : !this.gmailOAuth.credentials ? "no-creds" : !this.gmailOAuth.credentials.access_token ? "no-token" : "ok";
      const dayCalendarEvents = await this.getCalendarEvents(date, date);
      result.errors.push(`[DEBUG] ${date}: oauth=${oauthStatus}, cal=${this.lastCalendarDebug}`);
      for (const event of dayCalendarEvents) {
        const titleLower = event.title.toLowerCase();
        const isSprintMeeting = /daily|standup|stand-up|sprint|planning|retro|review|refinement|grooming|sync|réunion|rencontre|bamboo|infusion|global/.test(titleLower);
        if (!isSprintMeeting) continue;

        // Detect project from title or attendees
        const projectMatch = event.title.match(/([A-Z]{2,})/);
        let projectKey = projectMatch ? projectMatch[1] : "";
        if (!projectKey) {
          for (const att of event.attendees) {
            const co = att.match(/@([^.]+)/)?.[1]?.toLowerCase();
            if (co) { const p = await this.findProjectByCompany(co); if (p) { projectKey = p.key; break; } }
          }
        }
        if (!projectKey) projectKey = /bamboo|infusion|team/.test(titleLower) ? "BS" : (mainProject || "BS");

        const sprintIssue = await this.findSprintMeetingsIssue(projectKey);
        const targetIssue = sprintIssue || projectKey + "-1";

        let desc = "Meeting";
        if (/daily|standup/.test(titleLower)) desc = "Daily standup";
        else if (/planning/.test(titleLower)) desc = "Sprint planning";
        else if (/retro/.test(titleLower)) desc = "Rétrospective";
        else if (/refinement|grooming/.test(titleLower)) desc = "Raffinement";
        else if (/infusion/.test(titleLower)) desc = "Infusion";
        else if (/bamboo|team/.test(titleLower)) desc = "Team sync";
        else desc = this.simplifyEmailSubject(event.title);

        const existingEntry = timesheetDay.entries.find(e => e.issueKey === targetIssue);
        if (existingEntry) {
          existingEntry.hours += event.durationMinutes / 60;
        } else {
          timesheetDay.entries.push({ issueKey: targetIssue, hours: event.durationMinutes / 60, description: desc, project: projectKey });
        }
        timesheetDay.totalHours += event.durationMinutes / 60;
      }

      // Add email-based tasks (0.25h each)
      const dayEmailTasks = emailTasksByDate.get(date) || [];
      const addedEmailIssues = new Set<string>();
      for (const emailTask of dayEmailTasks) {
        if (emailTask.issueKey && !addedEmailIssues.has(emailTask.issueKey)) {
          // Check if this issue is already in entries from commits
          const existingEntry = timesheetDay.entries.find(e => e.issueKey === emailTask.issueKey);
          if (!existingEntry) {
            timesheetDay.entries.push({
              issueKey: emailTask.issueKey,
              hours: 0.25, // Minimum 15 min for email tasks
              description: `Suivi client - ${this.simplifyEmailSubject(emailTask.email.subject)}`,
              project: emailTask.issueKey.split("-")[0],
            });
            timesheetDay.totalHours += 0.25;
            addedEmailIssues.add(emailTask.issueKey);
          }
        }
      }

      // Add calendar meeting tasks (using actual meeting duration)
      const dayCalendarTasks = calendarTasksByDate.get(date) || [];
      const addedCalendarIssues = new Set<string>();
      for (const calTask of dayCalendarTasks) {
        if (calTask.issueKey && !addedCalendarIssues.has(calTask.issueKey)) {
          // Check if this issue is already in entries from commits or emails
          const existingEntry = timesheetDay.entries.find(e => e.issueKey === calTask.issueKey);
          if (existingEntry) {
            // Add meeting time to existing entry
            existingEntry.hours += calTask.event.durationMinutes / 60;
            existingEntry.description += ` + Meeting: ${calTask.event.title}`;
          } else {
            // Create new entry for meeting
            timesheetDay.entries.push({
              issueKey: calTask.issueKey,
              hours: calTask.event.durationMinutes / 60,
              description: `Meeting - ${calTask.event.title}`,
              project: calTask.issueKey.split("-")[0],
            });
          }
          timesheetDay.totalHours += calTask.event.durationMinutes / 60;
          addedCalendarIssues.add(calTask.issueKey);
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
          const adjustableEntries = timesheetDay.entries.filter(e => !e.description.includes("Daily") && !e.description.includes("Weekly sync"));
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
