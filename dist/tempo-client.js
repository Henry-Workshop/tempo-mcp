"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TempoClient = void 0;
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
}
exports.TempoClient = TempoClient;
//# sourceMappingURL=tempo-client.js.map