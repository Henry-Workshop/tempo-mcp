"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TempoClient = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const googleapis_1 = require("googleapis");
const http = __importStar(require("http"));
const url = __importStar(require("url"));
const open_1 = __importDefault(require("open"));
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
    gmailOAuth = null;
    gmailTokenPath = null;
    cachedProjects = null;
    constructor(config) {
        this.tempoToken = config.tempoToken;
        this.jiraToken = config.jiraToken;
        this.jiraEmail = config.jiraEmail;
        this.jiraBaseUrl = config.jiraBaseUrl.replace(/\/$/, "");
        this.accountFieldId = config.accountFieldId || "10026";
        this.defaultRole = config.defaultRole || "Dev";
        // Setup Gmail OAuth if credentials provided
        if (config.gmailClientId && config.gmailClientSecret) {
            this.gmailOAuth = new googleapis_1.google.auth.OAuth2(config.gmailClientId, config.gmailClientSecret, "http://localhost:3000/oauth2callback");
            this.gmailTokenPath = config.gmailTokenPath || (0, path_1.join)(process.env.HOME || process.env.USERPROFILE || ".", ".tempo-gmail-token.json");
            // Load existing token if available
            if ((0, fs_1.existsSync)(this.gmailTokenPath)) {
                try {
                    const token = JSON.parse((0, fs_1.readFileSync)(this.gmailTokenPath, "utf8"));
                    this.gmailOAuth.setCredentials(token);
                }
                catch {
                    // Token file invalid, will need to re-auth
                }
            }
        }
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
    /**
     * Check if Gmail OAuth is configured and authenticated
     */
    isGmailConfigured() {
        return this.gmailOAuth !== null && this.gmailOAuth.credentials?.access_token !== undefined;
    }
    /**
     * Get Gmail OAuth URL for user to authorize
     */
    getGmailAuthUrl() {
        if (!this.gmailOAuth)
            return null;
        return this.gmailOAuth.generateAuthUrl({
            access_type: "offline",
            scope: ["https://www.googleapis.com/auth/gmail.readonly"],
            prompt: "consent",
        });
    }
    /**
     * Authenticate Gmail via OAuth - starts local server to receive callback
     */
    async authenticateGmail() {
        if (!this.gmailOAuth) {
            throw new Error("Gmail OAuth not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.");
        }
        return new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                try {
                    const reqUrl = new url.URL(req.url, `http://localhost:3000`);
                    if (reqUrl.pathname === "/oauth2callback") {
                        const code = reqUrl.searchParams.get("code");
                        if (code) {
                            const { tokens } = await this.gmailOAuth.getToken(code);
                            this.gmailOAuth.setCredentials(tokens);
                            // Save token for future use
                            if (this.gmailTokenPath) {
                                (0, fs_1.writeFileSync)(this.gmailTokenPath, JSON.stringify(tokens));
                            }
                            res.writeHead(200, { "Content-Type": "text/html" });
                            res.end("<h1>Authentication successful!</h1><p>You can close this window.</p>");
                            server.close();
                            resolve(true);
                        }
                        else {
                            res.writeHead(400, { "Content-Type": "text/html" });
                            res.end("<h1>Authentication failed</h1><p>No code received.</p>");
                            server.close();
                            resolve(false);
                        }
                    }
                }
                catch (e) {
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
                    await (0, open_1.default)(authUrl);
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
    async getEmails(startDate, endDate) {
        if (!this.gmailOAuth || !this.gmailOAuth.credentials?.access_token) {
            return []; // Gmail not configured or not authenticated
        }
        const emails = [];
        const gmail = googleapis_1.google.gmail({ version: "v1", auth: this.gmailOAuth });
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
                                id: msg.id,
                                format: "full",
                            });
                            const headers = fullMsg.data.payload?.headers || [];
                            const getHeader = (name) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
                            // Parse date
                            const dateHeader = getHeader("Date");
                            let emailDate = startDate;
                            if (dateHeader) {
                                try {
                                    emailDate = new Date(dateHeader).toISOString().split("T")[0];
                                }
                                catch {
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
                        }
                        catch {
                            // Skip individual message errors
                        }
                    }
                }
            }
        }
        catch (e) {
            // Gmail API error, return empty
            console.error("Gmail API error:", e);
        }
        return emails;
    }
    /**
     * Get all Jira projects (cached)
     */
    async getAllJiraProjects() {
        if (this.cachedProjects) {
            return this.cachedProjects;
        }
        try {
            const response = await this.jiraRequest("/rest/api/2/project");
            this.cachedProjects = response.map(p => ({ key: p.key, name: p.name }));
            return this.cachedProjects;
        }
        catch {
            return [];
        }
    }
    /**
     * Extract company name from email recipient
     * Handles formats like: "John Doe <john@company.com>", "john@company.com"
     */
    extractCompanyFromEmail(email) {
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
        if (!domainMatch)
            return null;
        // Return the company name (first part of domain, lowercase)
        return domainMatch[1].toLowerCase();
    }
    /**
     * Find Jira project by company name using fuzzy matching
     */
    async findProjectByCompany(companyName) {
        const projects = await this.getAllJiraProjects();
        const searchName = companyName.toLowerCase();
        // First: exact match on project key
        const exactKeyMatch = projects.find(p => p.key.toLowerCase() === searchName);
        if (exactKeyMatch)
            return exactKeyMatch;
        // Second: project name contains company name
        const nameContains = projects.find(p => p.name.toLowerCase().includes(searchName));
        if (nameContains)
            return nameContains;
        // Third: project name (without spaces) matches company name
        // e.g., "laurinlaurin" matches "Laurin Laurin"
        const nameNoSpaces = projects.find(p => p.name.toLowerCase().replace(/\s+/g, '').includes(searchName) ||
            searchName.includes(p.name.toLowerCase().replace(/\s+/g, '')));
        if (nameNoSpaces)
            return nameNoSpaces;
        // Fourth: company name contains project key (for abbreviations)
        const keyInCompany = projects.find(p => searchName.includes(p.key.toLowerCase()));
        if (keyInCompany)
            return keyInCompany;
        // Fifth: any word from project name is in company name
        const wordMatch = projects.find(p => {
            const projectWords = p.name.toLowerCase().split(/\s+/);
            return projectWords.some(word => word.length > 3 && searchName.includes(word));
        });
        if (wordMatch)
            return wordMatch;
        // Sixth: fuzzy match - company name starts with similar letters as project
        const fuzzyMatch = projects.find(p => {
            const projectWords = p.name.toLowerCase().split(/\s+/);
            return projectWords.some(word => word.startsWith(searchName.substring(0, 3)));
        });
        if (fuzzyMatch)
            return fuzzyMatch;
        return null;
    }
    /**
     * Search for Jira issues in a project's current sprint matching search terms
     * Prioritizes: 1) current sprint, 2) recent issues (30 days)
     */
    async searchIssuesInProject(projectKey, searchTerms) {
        // First: try to find in current sprint (most relevant for timesheet)
        try {
            const sprintJql = encodeURIComponent(`project = ${projectKey} AND sprint in openSprints() AND text ~ "${searchTerms}" ORDER BY updated DESC`);
            const sprintResponse = await this.jiraRequest(`/rest/api/3/search/jql?jql=${sprintJql}&maxResults=1&fields=summary`);
            if (sprintResponse.issues && sprintResponse.issues.length > 0) {
                return sprintResponse.issues[0].key;
            }
        }
        catch {
            // Sprint search failed, try without sprint filter
        }
        // Second: try recent issues in project (last 30 days)
        try {
            const recentJql = encodeURIComponent(`project = ${projectKey} AND updated >= -30d AND text ~ "${searchTerms}" ORDER BY updated DESC`);
            const recentResponse = await this.jiraRequest(`/rest/api/3/search/jql?jql=${recentJql}&maxResults=1&fields=summary`);
            if (recentResponse.issues && recentResponse.issues.length > 0) {
                return recentResponse.issues[0].key;
            }
        }
        catch {
            // Search failed
        }
        return null;
    }
    /**
     * Match SENT emails to Jira issues by:
     * 1. Finding explicit Jira issue keys in subject/body
     * 2. Matching recipient company to Jira project, then searching for relevant issues
     */
    async matchEmailsToJiraIssues(emails) {
        const matches = [];
        // Only process SENT emails - these represent work done for clients
        const sentEmails = emails.filter(e => e.isSent);
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
            // Try to match by company -> project -> search for issue
            const companyName = this.extractCompanyFromEmail(email);
            if (companyName) {
                const project = await this.findProjectByCompany(companyName);
                if (project) {
                    // Extract meaningful search terms from email subject (skip common words)
                    const stopWords = ['re', 'fwd', 'fw', 'the', 'and', 'for', 'from', 'with', 'about'];
                    const searchTerms = email.subject
                        .split(/[\s:,\-\[\]]+/)
                        .filter(w => w.length > 2 && !stopWords.includes(w.toLowerCase()))
                        .slice(0, 3)
                        .join(" ");
                    if (searchTerms) {
                        const issueKey = await this.searchIssuesInProject(project.key, searchTerms);
                        if (issueKey) {
                            matches.push({
                                email,
                                issueKey,
                                confidence: "medium",
                                reason: `Matched ${companyName} -> ${project.name}, found issue for "${searchTerms}"`,
                            });
                            continue;
                        }
                    }
                    // No specific issue found, but we know the project - skip (don't add low confidence)
                    continue;
                }
            }
            // Skip emails we can't match - don't add low confidence matches
        }
        return matches;
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
        // Fetch and match emails (if Gmail is configured)
        const emailTasksByDate = new Map();
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
        }
        catch {
            // Gmail not configured or error, continue without emails
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
                // Helper to round to nearest 0.25 (15 min blocks)
                const roundTo15Min = (h) => Math.round(h * 4) / 4;
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
            const addedEmailIssues = new Set();
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
                const roundTo15Min = (h) => Math.round(h * 4) / 4;
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