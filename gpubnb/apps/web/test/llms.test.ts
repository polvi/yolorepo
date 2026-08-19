import { describe, expect, it } from 'vitest';
import { llmsTxt } from '../worker/llms';

describe('llms.txt', () => {
  const txt = llmsTxt('gpubnb.example.org');
  it('describes the public and host API on the serving host', () => {
    expect(txt).toContain('# gpubnb');
    expect(txt).toContain('https://gpubnb.example.org/api/listings');
    expect(txt).toContain('/api/golden');
    expect(txt).toContain('/api/models');
    expect(txt).toContain('/api/disputes');
    expect(txt).toContain('/api/listings/:id/attest');
    expect(txt).toContain('/api/listings/:id/heartbeat');
    expect(txt).toContain('Bearer gb_');
  });
  it('derives the auth host from the serving host and carries the attributions', () => {
    expect(txt).toContain('https://auth.example.org');
    expect(txt).toContain('https://authgravity.org');
    expect(txt).toContain('https://infinitelogic.org');
    expect(txt).not.toContain('proc.io');
  });
  it('states what the marketplace does not do', () => {
    expect(txt).toMatch(/never sees prompts or money/);
    expect(txt).toMatch(/simulated/);
  });
});
