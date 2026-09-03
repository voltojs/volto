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

/**
 * An error response from the gateway. Carries the HTTP status so callers can
 * branch on specific conditions (e.g. 409) without matching on message text,
 * which is server-generated English and not meant to be parsed.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      detail?.error ?? `Request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const fetchProjects = () => request<Project[]>('/projects');

export const createProject = (input: { name: string; path: string }) =>
  request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const deleteProject = (id: string) =>
  request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const fetchProviders = () => request<Provider[]>('/providers');

export const createProvider = (input: ProviderInput) =>
  request<Provider>('/providers', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const updateProvider = (id: string, input: Partial<ProviderInput>) =>
  request<Provider>(`/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });

export const deleteProvider = (id: string) =>
  request<void>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Ask the gateway to open a native directory dialog on the machine it runs on.
 * A null path means the user cancelled — that is not an error.
 */
export const pickDirectory = () =>
  request<{ path: string | null }>('/fs/pick-directory', { method: 'POST' });
