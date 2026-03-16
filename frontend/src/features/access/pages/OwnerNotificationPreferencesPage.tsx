import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  getOwnerNotificationPreferences,
  updateOwnerNotificationPreferences
} from '../../../api/features/accessClient';
import { Button } from '../../../components/Button';
import { useToast } from '../../../components/Toast';

export default function OwnerNotificationPreferencesPage() {
  const toast = useToast();
  const [inAppOptIn, setInAppOptIn] = useState(true);
  const [emailOptIn, setEmailOptIn] = useState(true);

  const preferencesQuery = useQuery({
    queryKey: ['owner', 'notification-preferences'],
    queryFn: () => getOwnerNotificationPreferences()
  });

  useEffect(() => {
    if (!preferencesQuery.data) {
      return;
    }
    setInAppOptIn(preferencesQuery.data.inAppOptIn);
    setEmailOptIn(preferencesQuery.data.emailOptIn);
  }, [preferencesQuery.data]);

  const updatePreferencesMutation = useMutation({
    mutationFn: updateOwnerNotificationPreferences,
    onSuccess: (next) => {
      setInAppOptIn(next.inAppOptIn);
      setEmailOptIn(next.emailOptIn);
      toast.push({
        title: 'Preferences saved',
        description: 'Owner notification settings were updated.'
      });
    }
  });

  async function handleSave() {
    await updatePreferencesMutation.mutateAsync({
      inAppOptIn,
      emailOptIn
    });
  }

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Owner Notification Preferences</h2>
          <p className="muted-text">
            Admins always receive pending-member notifications. Owners can opt in or out here.
          </p>
        </div>
      </div>

      {preferencesQuery.isLoading ? <p className="muted-text">Loading owner preferences...</p> : null}
      {preferencesQuery.isError ? (
        <p className="error-text">
          {preferencesQuery.error instanceof Error
            ? preferencesQuery.error.message
            : 'Owner preferences could not be loaded.'}
        </p>
      ) : null}

      {!preferencesQuery.isLoading && !preferencesQuery.isError ? (
        <div className="stack">
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={inAppOptIn}
              onChange={(event) => setInAppOptIn(event.target.checked)}
            />
            Receive pending-member in-app notifications
          </label>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={emailOptIn}
              onChange={(event) => setEmailOptIn(event.target.checked)}
            />
            Receive pending-member email notifications
          </label>
          <div className="page-actions">
            <Button type="button" onClick={() => void handleSave()} disabled={updatePreferencesMutation.isPending}>
              {updatePreferencesMutation.isPending ? 'Saving...' : 'Save Preferences'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
