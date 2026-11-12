// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as GatewayBase from '../gateway-base';

beforeEach(async () => {
  localStorage.clear();
  delete window.__VOLTO_CONFIG__;
  // A fresh module instance per test: `DEV_DEFAULT` is frozen at import time.
  vi.resetModules();
  const { resetGatewayBaseForTest } = await import('../gateway-base');
  resetGatewayBaseForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('默认同源为空串', async () => {
  const { getGatewayBase, gatewayUrl } = await import('../gateway-base');
  expect(getGatewayBase()).toBe('');
  expect(gatewayUrl('/events?sessionId=a')).toBe('/events?sessionId=a');
});
it('注入值优先，localStorage 覆盖注入', async () => {
  const { getGatewayBase, resetGatewayBaseForTest } =
    await import('../gateway-base');
  window.__VOLTO_CONFIG__ = { gatewayUrl: 'https://gw.example.com' };
  resetGatewayBaseForTest();
  expect(getGatewayBase()).toBe('https://gw.example.com');
  localStorage.setItem('volto.gatewayUrl', 'https://other.example.com');
  resetGatewayBaseForTest();
  expect(getGatewayBase()).toBe('https://other.example.com');
});
it('拼接不产生双斜杠', async () => {
  const { gatewayUrl, resetGatewayBaseForTest } =
    await import('../gateway-base');
  localStorage.setItem('volto.gatewayUrl', 'https://gw.example.com/');
  resetGatewayBaseForTest();
  expect(gatewayUrl('/health')).toBe('https://gw.example.com/health');
});
// R17: `next dev` keeps the browser-visible `/gateway` prefix so the dev
// rewrite keeps matching; only an exported production build is same-origin.
it('开发构建的默认前缀是 /gateway，导出构建为空串', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.resetModules();
  const dev = (await import('../gateway-base')) as typeof GatewayBase;
  expect(dev.getGatewayBase()).toBe('/gateway');
  expect(dev.gatewayUrl('/events?sessionId=a')).toBe(
    '/gateway/events?sessionId=a',
  );

  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  const prod = (await import('../gateway-base')) as typeof GatewayBase;
  expect(prod.getGatewayBase()).toBe('');
  expect(prod.gatewayUrl('/events?sessionId=a')).toBe('/events?sessionId=a');
});
it('localStorage 覆盖开发默认前缀', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.resetModules();
  const dev = (await import('../gateway-base')) as typeof GatewayBase;
  localStorage.setItem('volto.gatewayUrl', 'https://gw.example.com');
  dev.resetGatewayBaseForTest();
  expect(dev.gatewayUrl('/health')).toBe('https://gw.example.com/health');
});
it('首尾空白被裁剪，只有斜杠的 base 等价于同源', async () => {
  const { getGatewayBase, gatewayUrl, resetGatewayBaseForTest } =
    await import('../gateway-base');
  localStorage.setItem('volto.gatewayUrl', '  https://gw.example.com/  ');
  resetGatewayBaseForTest();
  expect(getGatewayBase()).toBe('https://gw.example.com');

  localStorage.setItem('volto.gatewayUrl', '/');
  resetGatewayBaseForTest();
  expect(getGatewayBase()).toBe('');
  expect(gatewayUrl('/health')).toBe('/health');
});
it('只解析一次并缓存，resetGatewayBaseForTest 使其失效', async () => {
  const { getGatewayBase, resetGatewayBaseForTest } =
    await import('../gateway-base');
  expect(getGatewayBase()).toBe('');
  localStorage.setItem('volto.gatewayUrl', 'https://later.example.com');
  expect(getGatewayBase()).toBe('');
  resetGatewayBaseForTest();
  expect(getGatewayBase()).toBe('https://later.example.com');
});
it('缺少前导斜杠的 path 也能拼出合法地址', async () => {
  const { gatewayUrl, resetGatewayBaseForTest } =
    await import('../gateway-base');
  localStorage.setItem('volto.gatewayUrl', 'https://gw.example.com');
  resetGatewayBaseForTest();
  expect(gatewayUrl('health')).toBe('https://gw.example.com/health');
});
