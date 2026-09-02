/**
 * Thin fetch wrappers over the gateway's configuration endpoints.
 *
 * Credentials never travel back from the server: providers carry only a
 * masked key for display. A plaintext apiKey flows one way, in request bodies.
 */

import { SERVER_URL } from './agent-config';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface Model {
  id: string;
  name: string;
  code: string;
}

export interface Provider {
  id: string;
  name: string;
  baseURL: string | null;
  apiKeyMasked: string | null;
  models: Model[];
}

export interface ProviderInput {
  name: string;
  baseURL?: string | null;
  /** Omit to keep the stored key unchanged. */
  apiKey?: string | null;
  models?: Array<{ id?: string; name: string; code: string }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const fetchProjects = () => request<Project[]>('/projects');

export const createProject = (input: { name: string; path: string }) =>
  request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) });

export const deleteProject = (id: string) =>
  request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const fetchProviders = () => request<Provider[]>('/providers');

export const createProvider = (input: ProviderInput) =>
  request<Provider>('/providers', { method: 'POST', body: JSON.stringify(input) });

export const updateProvider = (id: string, input: Partial<ProviderInput>) =>
  request<Provider>(`/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });

export const deleteProvider = (id: string) =>
  request<void>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
