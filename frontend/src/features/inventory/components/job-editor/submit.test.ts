import { describe, expect, it } from 'vitest';
import { buildJobEditorSubmitPayload } from './submit';

const baseArgs = {
  mode: 'create' as const,
  initialJobNumber: '',
  jobNumber: '12345',
  warehouse: 'MI1',
  sections: '',
  installDate: '',
  crewLeader: '',
  phases: [
    {
      id: 'primary',
      phaseNumber: 1,
      workScope: '',
      sections: '',
      installDate: '',
      installEndDate: '',
      crewLeader: '',
      laborStatus: 'ACTIVE' as const,
      workflowStatus: 'ACTIVE' as const,
      isPrimary: true
    }
  ],
  requirements: [],
  caulkRequirements: [],
  filmNameDraft: '',
  widthDraft: '',
  requiredFeetDraft: '',
  caulkRequiredTubesDraft: ''
};

describe('buildJobEditorSubmitPayload warehouse validation', () => {
  it('requires a configured warehouse before saving a job', () => {
    const result = buildJobEditorSubmitPayload({
      ...baseArgs,
      warehouse: ''
    });

    expect(result.payload).toBeNull();
    expect(result.error).toMatch(/Warehouse is required/);
  });

  it('preserves dynamic warehouse codes such as MI1 in the submit payload', () => {
    const result = buildJobEditorSubmitPayload(baseArgs);

    expect(result.error).toBeNull();
    expect(result.payload?.warehouse).toBe('MI1');
  });
});
