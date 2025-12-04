export interface EmailMessage {
    date: string;
    subject: string;
    from: string;
    to: string[];
    snippet: string;
    isSent: boolean;
}
export interface EmailTaskMatch {
    email: EmailMessage;
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
    linesChanged: number;
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
    weekStart: string;
    gitAuthor: string;
    projectsDir: string;
    dryRun?: boolean;
    mondayMeetingIssue?: string;
}
export interface TimesheetResult {
    days: TimesheetDay[];
    worklogsCreated: number;
    errors: string[];
}
export declare class TempoClient {
    private tempoToken;
    private jiraToken;
    private jiraEmail;
    private jiraBaseUrl;
    private accountFieldId;
    private defaultRole;
    private roleAttributeKey;
    private accountAttributeKey;
    private gmailOAuth;
    private gmailTokenPath;
    private cachedProjects;
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
    });
    private tempoRequest;
    private jiraRequest;
    initialize(): Promise<void>;
    getWorkAttributes(): Promise<WorkAttribute[]>;
    getRoles(): Promise<TempoRole[]>;
    getIssueId(issueKey: string): Promise<number>;
    getIssueAccount(issueKey: string): Promise<string | null>;
    /**
     * Get story points and summary for a Jira issue
     * Story points field varies by Jira instance - common fields: customfield_10016, customfield_10026
     */
    getIssueDetails(issueKey: string): Promise<{
        storyPoints: number | null;
        summary: string;
    }>;
    getCurrentUserAccountId(): Promise<string>;
    getWorklogs(startDate: string, endDate: string): Promise<TempoWorklog[]>;
    getWorklog(worklogId: string): Promise<TempoWorklog>;
    findSprintMeetingsIssue(projectKey: string): Promise<string | null>;
    findActiveProjectAccount(projectKey: string, excludeAccount?: string): Promise<string | null>;
    /**
     * Check if Gmail OAuth is configured and authenticated
     */
    isGmailConfigured(): boolean;
    /**
     * Get Gmail OAuth URL for user to authorize
     */
    getGmailAuthUrl(): string | null;
    /**
     * Authenticate Gmail via OAuth - starts local server to receive callback
     */
    authenticateGmail(): Promise<boolean>;
    /**
     * Fetch emails from Gmail via API for a date range
     */
    getEmails(startDate: string, endDate: string): Promise<EmailMessage[]>;
    /**
     * Get all Jira projects (cached)
     */
    getAllJiraProjects(): Promise<JiraProject[]>;
    /**
     * Extract company name from email recipient
     * Handles formats like: "John Doe <john@company.com>", "john@company.com"
     */
    private extractCompanyFromEmail;
    /**
     * Find Jira project by company name using fuzzy matching
     */
    private findProjectByCompany;
    /**
     * Search for Jira issues in a project matching search terms
     */
    private searchIssuesInProject;
    /**
     * Match SENT emails to Jira issues by:
     * 1. Finding explicit Jira issue keys in subject/body
     * 2. Matching recipient company to Jira project, then searching for relevant issues
     */
    matchEmailsToJiraIssues(emails: EmailMessage[]): Promise<EmailTaskMatch[]>;
    createWorklog(params: CreateWorklogParams): Promise<TempoWorklog>;
    updateWorklog(params: UpdateWorklogParams): Promise<TempoWorklog>;
    deleteWorklog(worklogId: string): Promise<void>;
    /**
     * Scan a directory for git repositories
     */
    scanGitRepos(projectsDir: string): string[];
    /**
     * Extract commits from a git repo for a specific date range and author
     */
    getGitCommits(repoPath: string, startDate: string, endDate: string, author: string): GitCommit[];
    /**
     * Generate a client-friendly description from commit messages
     */
    private generateDescription;
    /**
     * Generate timesheet from git commits
     */
    generateTimesheet(params: GenerateTimesheetParams): Promise<TimesheetResult>;
}
//# sourceMappingURL=tempo-client.d.ts.map