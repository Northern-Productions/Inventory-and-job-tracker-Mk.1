import { describe, expect, it } from 'vitest';
import {
  buildPendingJobEditorDraftMessage,
  getPendingJobEditorDrafts
} from './jobEditorDrafts';

describe('jobEditorDrafts', () => {
  it('flags pending film drafts when film inputs have unsaved values', () => {
    expect(
      getPendingJobEditorDrafts({
        filmName: 'Night Vision 35',
        widthIn: '',
        requiredFeet: '',
        caulkRequiredTubes: ''
      })
    ).toEqual({
      hasPendingFilmRequirementDraft: true,
      hasPendingCaulkRequirementDraft: false
    });
    expect(
      buildPendingJobEditorDraftMessage({
        hasPendingFilmRequirementDraft: true,
        hasPendingCaulkRequirementDraft: false
      })
    ).toBe('Add or clear the pending film requirement draft before saving.');
  });

  it('flags pending caulk drafts when required tubes are still in the draft input', () => {
    expect(
      getPendingJobEditorDrafts({
        filmName: '',
        widthIn: '',
        requiredFeet: '',
        caulkRequiredTubes: '58'
      })
    ).toEqual({
      hasPendingFilmRequirementDraft: false,
      hasPendingCaulkRequirementDraft: true
    });
    expect(
      buildPendingJobEditorDraftMessage({
        hasPendingFilmRequirementDraft: false,
        hasPendingCaulkRequirementDraft: true
      })
    ).toBe('Add or clear the pending caulk requirement draft before saving.');
  });

  it('builds a combined warning when both draft types are still pending', () => {
    const pendingDrafts = getPendingJobEditorDrafts({
      filmName: '',
      widthIn: '60',
      requiredFeet: '',
      caulkRequiredTubes: '12'
    });

    expect(pendingDrafts).toEqual({
      hasPendingFilmRequirementDraft: true,
      hasPendingCaulkRequirementDraft: true
    });
    expect(buildPendingJobEditorDraftMessage(pendingDrafts)).toBe(
      'Add or clear the pending film and caulk requirement drafts before saving.'
    );
  });

  it('stays clear when only saved requirement rows remain and the draft inputs are empty', () => {
    const pendingDrafts = getPendingJobEditorDrafts({
      filmName: '   ',
      widthIn: '   ',
      requiredFeet: '   ',
      caulkRequiredTubes: '   '
    });

    expect(pendingDrafts).toEqual({
      hasPendingFilmRequirementDraft: false,
      hasPendingCaulkRequirementDraft: false
    });
    expect(buildPendingJobEditorDraftMessage(pendingDrafts)).toBe('');
  });
});
