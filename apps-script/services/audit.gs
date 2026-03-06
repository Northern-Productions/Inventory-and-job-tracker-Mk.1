// Paste into Apps Script file: audit.gs

function createLogId_() {
  var timestamp = Utilities.formatDate(new Date(), 'GMT', 'yyyyMMddHHmmssSSS');
  var suffix = ('000' + Math.floor(Math.random() * 1000)).slice(-3);
  return timestamp + '-' + suffix;
}

function parseStoredJson_(value) {
  var text = asTrimmedString_(value);
  if (!text || text === 'null') {
    return null;
  }

  return JSON.parse(text);
}

function appendAudit_(action, boxId, beforeValue, afterValue, user, notes) {
  var sheet = getAuditSheet_();
  var logId = createLogId_();

  sheet.appendRow([
    logId,
    new Date().toISOString(),
    action,
    boxId,
    beforeValue === null ? 'null' : JSON.stringify(beforeValue),
    afterValue === null ? 'null' : JSON.stringify(afterValue),
    asTrimmedString_(user),
    asTrimmedString_(notes)
  ]);

  clearRequestScopedCache_('auditEntries');

  return logId;
}

function parseAuditRow_(row) {
  return {
    logId: asTrimmedString_(row[0]),
    date: asTrimmedString_(row[1]),
    action: asTrimmedString_(row[2]),
    boxId: asTrimmedString_(row[3]),
    before: parseStoredJson_(row[4]),
    after: parseStoredJson_(row[5]),
    user: asTrimmedString_(row[6]),
    notes: asTrimmedString_(row[7])
  };
}

function readAuditEntries_() {
  var cached = getRequestScopedValue_('auditEntries', 'all');
  if (cached !== null) {
    return cached;
  }

  var sheet = getAuditSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return setRequestScopedValue_('auditEntries', 'all', []);
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, AUDIT_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = parseAuditRow_(rows[index]);
    if (entry.logId) {
      entries.push(entry);
    }
  }

  return setRequestScopedValue_('auditEntries', 'all', entries);
}

function findAuditEntryByLogId_(logId) {
  var normalized = requireString_(logId, 'logId');
  var entries = readAuditEntries_();

  for (var index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].logId === normalized) {
      return entries[index];
    }
  }

  return null;
}

function listAuditService_(params) {
  var from = asTrimmedString_(params.from);
  var to = asTrimmedString_(params.to);
  var user = asTrimmedString_(params.user).toLowerCase();
  var action = asTrimmedString_(params.action).toLowerCase();
  var entries = readAuditEntries_();
  var filtered = [];

  for (var index = entries.length - 1; index >= 0; index -= 1) {
    var entry = entries[index];
    var entryDate = entry.date.slice(0, 10);

    if (from && entryDate < from) {
      continue;
    }

    if (to && entryDate > to) {
      continue;
    }

    if (user && entry.user.toLowerCase().indexOf(user) === -1) {
      continue;
    }

    if (action && entry.action.toLowerCase().indexOf(action) === -1) {
      continue;
    }

    filtered.push(entry);
  }

  return {
    data: {
      entries: filtered
    }
  };
}

function getAuditByBoxService_(params) {
  var boxId = requireString_(params.boxId, 'boxId');
  var entries = readAuditEntries_();
  var filtered = [];

  for (var index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].boxId === boxId) {
      filtered.push(entries[index]);
    }
  }

  return {
    data: {
      entries: filtered
    }
  };
}

function getCheckoutJobNumberFromAuditNotes_(notes) {
  var text = asTrimmedString_(notes);
  var match = text.match(/^Checked out for job\s+(.+)$/i);
  return match ? asTrimmedString_(match[1]) : '';
}

function findLatestCheckoutAuditEntryByBoxId_(boxId) {
  var normalizedBoxId = requireString_(boxId, 'boxId');
  var entries = readAuditEntries_();

  for (var index = entries.length - 1; index >= 0; index -= 1) {
    var entry = entries[index];
    if (entry.boxId !== normalizedBoxId || entry.action !== 'SET_STATUS') {
      continue;
    }

    if (entry.after && entry.after.status === 'CHECKED_OUT') {
      return entry;
    }
  }

  return null;
}

function undoAuditService_(payload) {
  var user = getAuthenticatedAuditUser_(payload);
  var reason = asTrimmedString_(payload.reason);
  var lock = LockService.getScriptLock();
  var warnings = [];

  lock.waitLock(30000);

  try {
    var auditEntry = findAuditEntryByLogId_(payload.logId);
    if (!auditEntry) {
      throw new Error('Audit entry not found.');
    }

    var current = findRowByBoxIdAcrossWarehouses_(auditEntry.boxId, true);
    var notes = 'Undo ' + auditEntry.action + (reason ? ': ' + reason : '');
    var resultBox;
    var newLogId;

    if (auditEntry.before) {
      resultBox = cloneObject_(auditEntry.before);

      if (current) {
        if (current.useZeroed) {
          appendBoxRow_(determineWarehouseFromBoxId_(resultBox.boxId), resultBox);
          deleteBoxRow_(current.warehouse, current.rowIndex, true);
        } else {
          updateBoxRow_(current.warehouse, current.rowIndex, resultBox);
        }
      } else {
        appendBoxRow_(determineWarehouseFromBoxId_(resultBox.boxId), resultBox);
      }

      if (
        auditEntry.action === 'SET_STATUS' &&
        auditEntry.after &&
        auditEntry.after.status === 'CHECKED_OUT'
      ) {
        var checkoutJobNumber = getCheckoutJobNumberFromAuditNotes_(auditEntry.notes);
        if (checkoutJobNumber) {
          var reactivatedFulfilledCount = reactivateFulfilledAllocationsForUndo_(
            auditEntry.boxId,
            checkoutJobNumber
          );
          if (reactivatedFulfilledCount > 0) {
            warnings.push(
              reactivatedFulfilledCount +
                ' allocation' +
                (reactivatedFulfilledCount === 1 ? ' was' : 's were') +
                ' reactivated for job ' +
                checkoutJobNumber +
                '.'
            );
          }
        }
      }

      if (auditEntry.action === 'ZERO_OUT_BOX') {
        var reactivatedCancelledCount = reactivateCancelledAllocationsForZeroUndo_(auditEntry.boxId);
        if (reactivatedCancelledCount > 0) {
          warnings.push(
            reactivatedCancelledCount +
              ' zero-cancelled allocation' +
              (reactivatedCancelledCount === 1 ? ' was' : 's were') +
            ' reactivated.'
          );
        }
      }

      if (
        auditEntry.after &&
        auditEntry.after.receivedDate &&
        auditEntry.before &&
        !auditEntry.before.receivedDate
      ) {
        var cancelledFilmOrderAllocations = cancelActiveFilmOrderAllocationsForBox_(
          auditEntry.boxId,
          user,
          'Cancelled because undo restored the box to its pre-receipt state.'
        );
        if (cancelledFilmOrderAllocations > 0) {
          warnings.push(
            cancelledFilmOrderAllocations +
              ' auto-allocation' +
              (cancelledFilmOrderAllocations === 1 ? ' was' : 's were') +
              ' cancelled because the linked box was reverted to pre-receipt.'
          );
        }
      }

      recalculateFilmOrdersForBoxLinks_(auditEntry.boxId, user);

      newLogId = appendAudit_(
        'UNDO',
        auditEntry.boxId,
        current ? toPublicBox_(current.box) : null,
        toPublicBox_(resultBox),
        user,
        notes
      );

      return {
        data: {
          box: toPublicBox_(resultBox),
          logId: newLogId
        },
        warnings: warnings
      };
    }

    if (!current) {
      throw new Error('Cannot undo add because the current box row is missing.');
    }

    deleteBoxRow_(current.warehouse, current.rowIndex, current.useZeroed === true);
    cancelActiveFilmOrderAllocationsForBox_(
      auditEntry.boxId,
      user,
      'Cancelled because the linked box was removed by undo.'
    );
    recalculateFilmOrdersForBoxLinks_(auditEntry.boxId, user);

    newLogId = appendAudit_(
      'UNDO_ADD_DELETE',
      auditEntry.boxId,
      toPublicBox_(current.box),
      null,
      user,
      notes
    );

    return {
      data: {
        box: null,
        logId: newLogId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}
