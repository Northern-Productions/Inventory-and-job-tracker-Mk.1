// Purpose: Keep provider orchestration deterministic across the local and Edge runtimes.

function trim(value) {
  return String(value || '').trim();
}

function requirePreparedUserId(value, createError) {
  const userId = trim(value);
  if (!userId) {
    throw createError(409, 'The account could not be resolved safely. Contact support.');
  }
  return userId;
}

function safeInviteError(createError) {
  return createError(502, 'The account invitation could not be completed. No membership was changed.');
}

function partialRecordError(createError) {
  return createError(
    502,
    'The account invitation was started, but organization access was not recorded. Retry Add Team Member safely.'
  );
}

export async function runTeamMemberOnboarding({
  email,
  name,
  role,
  classify,
  inviteNewAccount,
  resendPendingInvite,
  recordMembership,
  createError
}) {
  let prepared = await classify({ email, name, role });
  if (trim(prepared?.outcome)) {
    return prepared;
  }

  let action = trim(prepared?.action);
  if (action !== 'invite-new-user' && action !== 'invite-existing-unconfirmed') {
    throw createError(400, 'The invite could not be prepared safely.');
  }

  let inviteKind = action === 'invite-existing-unconfirmed' ? 'existing_unconfirmed' : 'new';
  let userId = trim(prepared?.userId);
  let invitedEmail = email;

  if (action === 'invite-existing-unconfirmed') {
    userId = requirePreparedUserId(userId, createError);
    try {
      await resendPendingInvite(email);
    } catch (_error) {
      prepared = await classify({ email, name, role });
      if (trim(prepared?.outcome)) {
        return prepared;
      }
      throw safeInviteError(createError);
    }
  } else {
    if (!name) {
      throw createError(400, 'Display name is required for a new account invitation.');
    }

    try {
      const invited = await inviteNewAccount({ email, name });
      userId = requirePreparedUserId(invited?.userId, createError);
      invitedEmail = trim(invited?.email).toLowerCase() || email;
    } catch (_error) {
      prepared = await classify({ email, name, role });
      if (trim(prepared?.outcome)) {
        return prepared;
      }

      action = trim(prepared?.action);
      if (action !== 'invite-existing-unconfirmed') {
        throw safeInviteError(createError);
      }

      inviteKind = 'existing_unconfirmed';
      userId = requirePreparedUserId(prepared?.userId, createError);
      try {
        await resendPendingInvite(email);
      } catch (_resendError) {
        throw safeInviteError(createError);
      }
    }
  }

  try {
    return await recordMembership({
      userId,
      email: invitedEmail,
      name,
      role,
      inviteKind
    });
  } catch (_error) {
    throw partialRecordError(createError);
  }
}
