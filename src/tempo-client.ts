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
    // Fetch work attributes to get the correct keys for role and account
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
    if (accountField && typeof accountField === "object" && "key" in accountField) {
      return (accountField as { key: string }).key;
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

  async createWorklog(params: CreateWorklogParams): Promise<TempoWorklog> {
    await this.initialize();

    const issueId = await this.getIssueId(params.issueKey);
    const authorAccountId = await this.getCurrentUserAccountId();

    // Get account from issue if not provided
    let accountKey = params.accountKey;
    if (!accountKey) {
      accountKey = await this.getIssueAccount(params.issueKey) || undefined;
    }

    const role = params.role || this.defaultRole;

    const attributes: Array<{ key: string; value: string }> = [];

    if (this.roleAttributeKey) {
      attributes.push({ key: this.roleAttributeKey, value: role });
    }

    if (this.accountAttributeKey && accountKey) {
      attributes.push({ key: this.accountAttributeKey, value: accountKey });
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
}
