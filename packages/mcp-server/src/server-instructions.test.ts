import { describe, expect, it } from 'vitest';
import { BUNDLED_PONYTAIL_SKILL_ID } from './ponytail-runtime.js';
import { MCP_OUTCOME_DRIVEN_INSTRUCTIONS, buildMcpInstructions } from './server.js';

describe('MCP Ponytail instructions', () => {
  it('keeps the OFF instruction contract identical to the existing baseline', () => {
    expect(buildMcpInstructions('off')).toBe(MCP_OUTCOME_DRIVEN_INSTRUCTIONS);
    expect(buildMcpInstructions('off')).not.toContain(BUNDLED_PONYTAIL_SKILL_ID);
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('use checkpoint_goal and session_handoff only');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('Never invoke generic handoff skills');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('USER_INSTRUCTIONS');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('batch-inspect its diff, tests, logs, and terminal results');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('request targeted repair only for verified gaps');
    expect(MCP_OUTCOME_DRIVEN_INSTRUCTIONS).toContain('avoid repeated status/log/result polling');
  });

  it.each(['lite', 'full', 'ultra'] as const)('adds a bounded exact-load directive for %s', (mode) => {
    const instructions = buildMcpInstructions(mode);
    expect(instructions).toContain(MCP_OUTCOME_DRIVEN_INSTRUCTIONS);
    expect(instructions).toContain(`Ponytail policy is ${mode.toUpperCase()}`);
    expect(instructions).toContain('call skill_load');
    expect(instructions).toContain(BUNDLED_PONYTAIL_SKILL_ID);
    expect(instructions).toContain('Do not substitute workspace/user copies');
    expect(instructions).toContain('required tests');
    expect(instructions.length).toBeLessThan(MCP_OUTCOME_DRIVEN_INSTRUCTIONS.length + 1_000);
  });
});
