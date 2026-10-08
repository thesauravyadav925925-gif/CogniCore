import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

const client = axios.create({ baseURL: API_BASE });

// --- Auth token plumbing ---
let authToken = null;
let onUnauthorized = null;

export function setAuthToken(token) {
  authToken = token;
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

client.interceptors.request.use((cfg) => {
  if (authToken) cfg.headers.Authorization = `Bearer ${authToken}`;
  return cfg;
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && onUnauthorized) onUnauthorized();
    return Promise.reject(err);
  }
);

export const api = {
  async register({ email, password, name }) {
    const { data } = await client.post('/api/auth/register', { email, password, name });
    return data;
  },

  async login({ email, password }) {
    const { data } = await client.post('/api/auth/login', { email, password });
    return data;
  },

  async me() {
    const { data } = await client.get('/api/auth/me');
    return data.user;
  },

  async health() {
    const { data } = await client.get('/api/health');
    return data;
  },

  async listDatasets() {
    const { data } = await client.get('/api/datasets');
    return data.datasets;
  },

  async getDataset(id) {
    const { data } = await client.get(`/api/datasets/${id}`);
    return data.dataset;
  },

  async deleteDataset(id) {
    const { data } = await client.delete(`/api/datasets/${id}`);
    return data;
  },

  async uploadFile(file, onProgress) {
    const form = new FormData();
    form.append('file', file);
    const { data } = await client.post('/api/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (evt) => {
        if (onProgress && evt.total) onProgress(Math.round((evt.loaded / evt.total) * 100));
      },
    });
    return data.dataset;
  },

  async getSchema(datasetId) {
    const { data } = await client.get(`/api/schema/${datasetId}`);
    return data;
  },

  async preview(datasetId, table, limit = 10) {
    const { data } = await client.get(`/api/datasets/${datasetId}/preview`, {
      params: { table, limit },
    });
    return data;
  },

  async connectDatabase(payload) {
    const { data } = await client.post('/api/connections', payload);
    return data.dataset;
  },

  async chat({ question, datasetIds, sessionId, analysisMode }) {
    const { data } = await client.post('/api/chat', { question, datasetIds, sessionId, analysisMode });
    return data;
  },

  async generateChart({ datasetId, sql, chartType, xField, yFields, title }) {
    const { data } = await client.post('/api/tools/chart', { datasetId, sql, chartType, xField, yFields, title });
    return data.chart;
  },

  async calculateMetric({ datasetId, sql, column, metric }) {
    const { data } = await client.post('/api/tools/calculate', { datasetId, sql, column, metric });
    return data;
  },

  /** Triggers a browser download for CSV/XLSX exports. */
  async exportData({ datasetId, sql, format, filename }) {
    const response = await client.post('/api/tools/export', { datasetId, sql, format, filename }, { responseType: 'blob' });
    downloadBlob(response.data, `${filename || 'export'}.${format}`);
  },

  /** Triggers a browser download for the generated PDF report. */
  async generateReport({ datasetId, sql, question, answer, title }) {
    const response = await client.post('/api/tools/report', { datasetId, sql, question, answer, title }, { responseType: 'blob' });
    downloadBlob(response.data, `${(title || 'report').replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`);
  },

  // ---------------- analytics (semantic layer, quality, KPIs, reports) ----------------
  async getQuality(datasetId) { const { data } = await client.get(`/api/analytics/${datasetId}/quality`); return data.quality; },
  async getKpis(datasetId) { const { data } = await client.get(`/api/analytics/${datasetId}/kpis`); return data.kpis; },
  async getExploreQuestions(datasetId) { const { data } = await client.get(`/api/analytics/${datasetId}/explore`); return data.questions; },
  async getSemantic(datasetId) { const { data } = await client.get(`/api/analytics/${datasetId}/semantic`); return data.semantic; },
  async getReport(datasetId) { const { data } = await client.get(`/api/analytics/${datasetId}/report`); return data.report; },
  async downloadReport(datasetId, format, name = 'management-report') {
    const r = await client.get(`/api/analytics/${datasetId}/report/download`, { params: { format }, responseType: 'blob' });
    downloadBlob(r.data, `${name}.${format}`);
  },
  /** Chart image (SVG) rebuilt server-side from live data; returns an object URL for <img>. */
  async chartSvgUrl({ datasetId, sql, question, chartType }) {
    const r = await client.post(`/api/analytics/${datasetId}/chart-svg`, { sql, question, chartType }, { responseType: 'blob' });
    return URL.createObjectURL(r.data);
  },
  async downloadChartSvg({ datasetId, sql, question, chartType }) {
    const r = await client.post(`/api/analytics/${datasetId}/chart-svg`, { sql, question, chartType }, { responseType: 'blob' });
    downloadBlob(r.data, 'chart.svg');
  },
  async exportAnalysis({ datasetId, sql, question, answer }) {
    const r = await client.post(`/api/analytics/${datasetId}/export-analysis`, { sql, question, answer }, { responseType: 'blob' });
    downloadBlob(r.data, 'analysis.xlsx');
  },

  // ---------------- data policies, knowledge ----------------
  async listPolicies(datasetId) { const { data } = await client.get(`/api/policies/${datasetId}`); return data; },
  async addPolicy(datasetId, body) { const { data } = await client.post(`/api/policies/${datasetId}`, body); return data; },
  async deletePolicy(datasetId, policyId) { const { data } = await client.delete(`/api/policies/${datasetId}/${policyId}`); return data; },
  async listKnowledge(datasetId) { const { data } = await client.get('/api/knowledge', { params: datasetId ? { datasetId } : {} }); return data; },
  async addKnowledge(body) { const { data } = await client.post('/api/knowledge', body); return data; },
  async deleteKnowledge(id) { const { data } = await client.delete(`/api/knowledge/${id}`); return data; },

  // ---------------- actions (human approval workflow) ----------------
  async listActions(status) { const { data } = await client.get('/api/actions', { params: status ? { status } : {} }); return data; },
  async proposeAction(body) { const { data } = await client.post('/api/actions', body); return data.action; },
  async approveAction(id, note) { const { data } = await client.post(`/api/actions/${id}/approve`, { note }); return data; },
  async rejectAction(id, note) { const { data } = await client.post(`/api/actions/${id}/reject`, { note }); return data; },

  // ---------------- admin: users, roles, audit ----------------
  async listUsers() { const { data } = await client.get('/api/admin/users'); return data.users; },
  async setUserRole(id, role) { const { data } = await client.patch(`/api/admin/users/${id}/role`, { role }); return data; },
  async listAudit(limit = 50) { const { data } = await client.get('/api/admin/audit', { params: { limit } }); return data.entries; },

  // ---------------- command center, dashboard, catalog, registry ----------------
  async getBriefing() { const { data } = await client.get('/api/analytics/briefing'); return data.briefing; },
  async getToolRegistry() { const { data } = await client.get('/api/analytics/registry'); return data; },
  async getCatalog(datasetId) { const { data } = await client.get(`/api/analytics/${datasetId}/catalog`); return data.catalog; },
  async setMeaning(datasetId, body) { const { data } = await client.put(`/api/analytics/${datasetId}/catalog/meaning`, body); return data; },
  async removeMeaning(datasetId, table, column) { const { data } = await client.delete(`/api/analytics/${datasetId}/catalog/meaning`, { params: { table, column } }); return data; },
  async getDashboard(datasetId, filters = {}) { const { data } = await client.get(`/api/analytics/${datasetId}/dashboard`, { params: { filters: JSON.stringify(filters) } }); return data.dashboard; },
  async validateSql(datasetId, sql) { const { data } = await client.post(`/api/analytics/${datasetId}/tool/validate`, { sql }); return data; },

  // ---------------- AI activity (traces) ----------------
  async listTraces(scope) { const { data } = await client.get('/api/traces', { params: scope ? { scope } : {} }); return data.traces; },
  async getTrace(id) { const { data } = await client.get(`/api/traces/${id}`); return data.trace; },

  // ---------------- preferences, sessions, models ----------------
  async getPreferences() { const { data } = await client.get('/api/preferences'); return data; },
  async setPreferences(patch) { const { data } = await client.put('/api/preferences', patch); return data.preferences; },
  async listSessions() { const { data } = await client.get('/api/auth/sessions'); return data.sessions; },
  async revokeSession(id) { const { data } = await client.delete(`/api/auth/sessions/${id}`); return data; },
  async logout() { const { data } = await client.post('/api/auth/logout'); return data; },
  async logoutOthers() { const { data } = await client.post('/api/auth/logout-all'); return data; },
  async getModelRouting() { const { data } = await client.get('/api/admin/models'); return data.routing; },

  // ---------------- REST / GraphQL source ----------------
  async connectApi(payload) { const { data } = await client.post('/api/connections/api', payload); return data.dataset; },
};

export { API_BASE };

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
