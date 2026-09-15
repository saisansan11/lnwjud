import { describe, expect, it } from 'vitest';
import { CodexInvocationBuilder, capabilitiesFromHelp } from './codex-capabilities.js';

describe('Codex sandbox capability', () => {
  it('discovers read-only stdin support and builds an explicit read-only invocation', () => {
    const capabilities = capabilitiesFromHelp([
      'Usage: codex exec [OPTIONS] [PROMPT]',
      'Commands:',
      '  exec  run a task',
      'Arguments:',
      '  [PROMPT] Initial instructions for the agent. If `-` is used, instructions are read from stdin.',
      'Options:',
      '  --sandbox <MODE>  Sandbox policy [possible values: read-only, workspace-write]',
    ].join('\n'));

    expect(capabilities.names).toEqual(expect.arrayContaining(['exec', 'sandbox', 'read-only', 'stdin-prompt']));
    expect(new CodexInvocationBuilder().build('codex.exe', capabilities, 'review project', 'read-only')).toEqual({
      ok: true,
      value: {
        executable: 'codex.exe',
        args: ['exec', '--sandbox', 'read-only', '-'],
        stdinText: 'review project',
      },
    });
  });

  it('discovers workspace-write stdin support and builds an explicit sandboxed invocation', () => {
    const capabilities = capabilitiesFromHelp([
      'Usage: codex exec [OPTIONS] [PROMPT]',
      'Commands:',
      '  exec  run a task',
      'Arguments:',
      '  [PROMPT] Initial instructions for the agent. If not provided as an argument, instructions are read from stdin.',
      'Options:',
      '  --sandbox <MODE>  Sandbox policy [possible values: read-only, workspace-write]',
    ].join('\n'));

    expect(capabilities.names).toEqual(expect.arrayContaining(['exec', 'sandbox', 'workspace-write', 'stdin-prompt']));
    expect(new CodexInvocationBuilder().build('codex.exe', capabilities, 'review project')).toEqual({
      ok: true,
      value: {
        executable: 'codex.exe',
        args: ['exec', '--sandbox', 'workspace-write', '-'],
        stdinText: 'review project',
      },
    });
  });

  it('falls back to the legacy exec prompt argument when stdin support was not verified', () => {
    const capabilities = capabilitiesFromHelp([
      'Usage: codex exec [OPTIONS] [PROMPT]',
      'Commands:',
      '  exec  run a task',
      'Options:',
      '  --sandbox <MODE>  Sandbox policy [possible values: read-only, workspace-write]',
    ].join('\n'));

    expect(capabilities.names).not.toContain('stdin-prompt');
    expect(new CodexInvocationBuilder().build('codex.exe', capabilities, 'legacy review')).toEqual({
      ok: true,
      value: {
        executable: 'codex.exe',
        args: ['exec', '--sandbox', 'workspace-write', 'legacy review'],
      },
    });
  });

  it('fails closed when workspace-write sandbox support was not observed', () => {
    const capabilities = capabilitiesFromHelp('Usage: codex\nCommands:\n  exec  run a task\n');

    expect(new CodexInvocationBuilder().build('codex.exe', capabilities, 'edit project')).toMatchObject({
      ok: false,
      error: { code: 'CODEX_NOT_AVAILABLE' },
    });
  });
});
