import apiClient from './client';

export async function login(email, password) {
  const { data } = await apiClient.post('/auth/login', { email, password });
  return data;
}

export async function fetchMe() {
  const { data } = await apiClient.get('/auth/me');
  return data;
}

export async function fetchConfig() {
  const { data } = await apiClient.get('/config');
  return data;
}

export async function fetchModels() {
  const { data } = await apiClient.get('/models');
  return data.models;
}

export async function fetchSessions() {
  const { data } = await apiClient.get('/sessions');
  return data;
}

export async function fetchSession(sessionId) {
  const { data } = await apiClient.get(`/sessions/${sessionId}`);
  return data;
}

export async function createSession(payload) {
  const { data } = await apiClient.post('/sessions', payload);
  return data;
}

export async function updateSession(sessionId, payload) {
  const { data } = await apiClient.patch(`/sessions/${sessionId}`, payload);
  return data;
}

export async function deleteSession(sessionId) {
  await apiClient.delete(`/sessions/${sessionId}`);
}

export async function fetchMessages(sessionId) {
  const { data } = await apiClient.get(`/sessions/${sessionId}/messages`);
  return data;
}

export async function sendMessage(sessionId, content, options = {}) {
  const form = new FormData();
  form.append('content', content);
  const { data } = await apiClient.post(`/sessions/${sessionId}/messages`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    signal: options.signal
  });
  return data;
}

export async function editMessage(sessionId, messageId, content, options = {}) {
  const { data } = await apiClient.patch(
    `/sessions/${sessionId}/messages/${messageId}`,
    {
      content
    },
    {
      signal: options.signal
    }
  );
  return data;
}

export async function listRuns(sessionId) {
  const { data } = await apiClient.get(`/traces/sessions/${sessionId}`);
  return data;
}

export async function getRun(runId) {
  const { data } = await apiClient.get(`/traces/${runId}`);
  return data;
}

export async function runTool(sessionId, payload) {
  const { data } = await apiClient.post(`/sessions/${sessionId}/tools/run`, payload);
  return data;
}

export async function fetchRagUploads() {
  const { data } = await apiClient.get('/rag/uploads');
  return data;
}

export async function uploadRagFiles(files) {
  const form = new FormData();
  Array.from(files || []).forEach((file) => form.append('files', file));
  const { data } = await apiClient.post('/rag/uploads', form, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return data;
}

export async function deleteRagUpload(uploadId) {
  await apiClient.delete(`/rag/uploads/${uploadId}`);
}

export async function queryRag(payload) {
  const { data } = await apiClient.post('/rag/query', payload);
  return data;
}
