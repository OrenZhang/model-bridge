import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { isolatedConfig, parseNodes } from '../src/network/config.js';
it('imports nodes while excluding subscription rules, TUN, DNS and externally accessible listeners', () => {
  const nodes = parseNodes('proxies:\n  - {name: Test, type: http, server: example.invalid, port: 443}\ntun: {enable: true}\nallow-lan: true\nrules: [MATCH,DIRECT]\nexternal-controller: 0.0.0.0:9090\ndns: {enable: true}\n');
  const runtime: any = parse(isolatedConfig(nodes, 'Test', 30001, 30002, 'private-proxy-key', 'private-controller-key'));
  expect(runtime.tun.enable).toBe(false); expect(runtime.dns.enable).toBe(false); expect(runtime['allow-lan']).toBe(false);
  expect(runtime['bind-address']).toBe('127.0.0.1'); expect(runtime['external-controller']).toBe('127.0.0.1:30002');
  expect(runtime.authentication).toEqual(['mb:private-proxy-key']); expect(runtime.secret).toBe('private-controller-key'); expect(runtime.rules).toEqual(['MATCH,Test']);
});
it('rejects nodes referencing local files or externally launched plugins', () => {
  expect(() => parseNodes('proxies: [{name: Test, type: ss, server: example.invalid, port: 443, plugin: arbitrary-command}]')).toThrow('暂不支持');
  expect(() => parseNodes('proxies: [{name: Test, type: trojan, server: example.invalid, port: 443, ws-opts: {private-key-file: /private/key}}]')).toThrow('本机文件');
});
it('never silently chooses a direct fallback when the selected node is absent', () => {
  const nodes = parseNodes('proxies: [{name: Test, type: socks5, server: localhost, port: 1080}]');
  expect(() => isolatedConfig(nodes, 'missing', 1, 2, 'a', 'b')).toThrow('不存在');
});
