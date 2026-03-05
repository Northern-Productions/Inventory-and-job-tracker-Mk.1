// Paste into Apps Script file: main.gs

function doGet(e) {
  return routeRequest_('GET', e || {});
}

function doPost(e) {
  return routeRequest_('POST', e || {});
}


// Paste into Apps Script file: http.gs

function successEnvelope_(data, warnings) {
  return {
    ok: true,
    data: data,
    warnings: warnings || []
  };
}

function errorEnvelope_(message, warnings) {
  return {
    ok: false,
    error: message,
    warnings: warnings || []
  };
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function resolveRoute_(e) {
  var raw = '/';

  if (e && e.parameter && e.parameter.path) {
    raw = String(e.parameter.path);
  } else if (e && e.pathInfo) {
    raw = '/' + String(e.pathInfo).replace(/^\/+/, '');
  }

  if (raw.charAt(0) !== '/') {
    raw = '/' + raw;
  }

  return raw;
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (_error) {
    throw new Error('Invalid JSON request body.');
  }
}

function cloneObject_(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function getAuthenticatedAuditUser_(payload) {
  var authUser = payload && payload.authUser ? payload.authUser : null;
  if (!authUser) {
    throw new Error('Google sign-in session is required.');
  }

  var email = requireString_(authUser.email, 'authUser.email');
  var name = requireString_(authUser.name, 'authUser.name');
  return name + ' <' + email + '>';
}


// Paste into Apps Script file: validate.gs

function asTrimmedString_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function requireString_(value, fieldName) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    throw new Error(fieldName + ' is required.');
  }

  return trimmed;
}

function normalizeDateString_(value, fieldName, allowBlank) {
  var trimmed = asTrimmedString_(value);

  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new Error(fieldName + ' is required.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(fieldName + ' must use yyyy-mm-dd.');
  }

  return trimmed;
}

function coerceNonNegativeNumber_(value, fieldName) {
  var parsed = Number(value);
  if (!isFinite(parsed)) {
    throw new Error(fieldName + ' must be numeric.');
  }

  if (parsed < 0) {
    throw new Error(fieldName + ' must be zero or greater.');
  }

  return parsed;
}

function coerceOptionalNonNegativeNumber_(value, fieldName) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    return null;
  }

  return coerceNonNegativeNumber_(trimmed, fieldName);
}

function coerceFeetValue_(value, fieldName, warnings, allowNegativeClamp) {
  var parsed = Number(value);
  if (!isFinite(parsed)) {
    throw new Error(fieldName + ' must be numeric.');
  }

  var floored = Math.floor(parsed);
  if (floored !== parsed) {
    warnings.push(fieldName + ' was rounded down to ' + floored + '.');
  }

  if (floored < 0) {
    if (allowNegativeClamp) {
      warnings.push(fieldName + ' was clamped to 0.');
      return 0;
    }

    throw new Error(fieldName + ' must be zero or greater.');
  }

  return floored;
}

function assertBoxStatus_(status) {
  var normalized = asTrimmedString_(status).toUpperCase();
  if (
    normalized !== 'ORDERED' &&
    normalized !== 'IN_STOCK' &&
    normalized !== 'CHECKED_OUT' &&
    normalized !== 'ZEROED' &&
    normalized !== 'RETIRED'
  ) {
    throw new Error('Status must be ORDERED, IN_STOCK, CHECKED_OUT, ZEROED, or RETIRED.');
  }

  return normalized;
}


// Paste into Apps Script file: sheets.gs

var BOX_HEADERS_ = [
  'BoxID',
  'Manufacturer',
  'FilmName',
  'WidthIn',
  'InitialFeet',
  'FeetAvailable',
  'LotRun',
  'Status',
  'OrderDate',
  'ReceivedDate',
  'InitialWeightLbs',
  'LastRollWeightLbs',
  'LastWeighedDate',
  'FilmKey',
  'CoreType',
  'CoreWeightLbs',
  'LfWeightLbsPerFt',
  'PurchaseCost',
  'Notes',
  'HasEverBeenCheckedOut',
  'LastCheckoutJob',
  'LastCheckoutDate',
  'ZeroedDate',
  'ZeroedReason',
  'ZeroedBy'
];

var AUDIT_HEADERS_ = ['LogID', 'Date', 'Action', 'BoxID', 'Before', 'After', 'User', 'Notes'];
var FILM_DATA_HEADERS_ = [
  'FilmKey',
  'Manufacturer',
  'FilmName',
  'SqFtWeightLbsPerSqFt',
  'DefaultCoreType',
  'SourceWidthIn',
  'SourceInitialFeet',
  'SourceInitialWeightLbs',
  'UpdatedAt',
  'SourceBoxId',
  'Notes'
];
var ROLL_WEIGHT_LOG_HEADERS_ = [
  'LogID',
  'BoxID',
  'Warehouse',
  'Manufacturer',
  'FilmName',
  'WidthIn',
  'JobNumber',
  'CheckedOutAt',
  'CheckedOutBy',
  'CheckedOutWeightLbs',
  'CheckedInAt',
  'CheckedInBy',
  'CheckedInWeightLbs',
  'WeightDeltaLbs',
  'FeetBefore',
  'FeetAfter',
  'Notes'
];
var ALLOCATIONS_HEADERS_ = [
  'AllocationID',
  'BoxID',
  'Warehouse',
  'JobNumber',
  'JobDate',
  'AllocatedFeet',
  'Status',
  'CreatedAt',
  'CreatedBy',
  'ResolvedAt',
  'ResolvedBy',
  'Notes',
  'CrewLeader',
  'FilmOrderID'
];
var LEGACY_ALLOCATIONS_HEADERS_ = [
  'AllocationID',
  'BoxID',
  'Warehouse',
  'JobNumber',
  'JobDate',
  'AllocatedFeet',
  'Status',
  'CreatedAt',
  'CreatedBy',
  'ResolvedAt',
  'ResolvedBy',
  'Notes'
];
var FILM_ORDERS_HEADERS_ = [
  'FilmOrderID',
  'JobNumber',
  'Warehouse',
  'Manufacturer',
  'FilmName',
  'WidthIn',
  'RequestedFeet',
  'CoveredFeet',
  'OrderedFeet',
  'RemainingToOrderFeet',
  'JobDate',
  'CrewLeader',
  'Status',
  'SourceBoxID',
  'CreatedAt',
  'CreatedBy',
  'ResolvedAt',
  'ResolvedBy',
  'Notes'
];
var FILM_ORDER_BOX_LINKS_HEADERS_ = [
  'LinkID',
  'FilmOrderID',
  'BoxID',
  'OrderedFeet',
  'AutoAllocatedFeet',
  'CreatedAt',
  'CreatedBy'
];
var JOBS_HEADERS_ = [
  'JobNumber',
  'Warehouse',
  'Sections',
  'DueDate',
  'LifecycleStatus',
  'CreatedAt',
  'CreatedBy',
  'UpdatedAt',
  'UpdatedBy',
  'Notes'
];
var JOB_REQUIREMENTS_HEADERS_ = [
  'RequirementID',
  'JobNumber',
  'Manufacturer',
  'FilmName',
  'WidthIn',
  'RequiredFeet',
  'CreatedAt',
  'CreatedBy',
  'UpdatedAt',
  'UpdatedBy',
  'Notes'
];
var LEGACY_BOX_HEADER_COUNT_ = 19;
var BOX_MINIMUM_REQUIRED_HEADERS_ = [
  'BoxID',
  'Manufacturer',
  'FilmName',
  'WidthIn',
  'InitialFeet',
  'FeetAvailable',
  'LotRun',
  'Status',
  'OrderDate',
  'ReceivedDate',
  'LastRollWeightLbs',
  'LastWeighedDate',
  'FilmKey',
  'CoreWeightLbs',
  'LfWeightLbsPerFt',
  'PurchaseCost',
  'Notes'
];

var BOX_HEADER_ALIASES_BY_INDEX_ = [
  ['boxid', 'boxid#', 'boxidnumber', 'boxidno', 'box'],
  ['manufacturer', 'mfr'],
  ['filmname', 'film'],
  ['widthin', 'width', 'widthinch', 'widthinches'],
  ['initialfeet', 'linearfeet', 'initiallf', 'feet', 'initialft'],
  ['feetavailable', 'availablefeet', 'availablelf', 'feetavail'],
  ['lotrun', 'lot'],
  ['status'],
  ['orderdate', 'ordereddate'],
  ['receiveddate', 'datereceived'],
  ['initialweightlbs', 'initialweight', 'initialweightlb'],
  ['lastrollweightlbs', 'lastrollweight', 'rollweight', 'lastweightlbs'],
  ['lastweigheddate', 'lastweighed', 'weigheddate'],
  ['filmkey'],
  ['coretype'],
  ['coreweightlbs', 'coreweight', 'coreweightlb'],
  ['lfweightlbsperft', 'lfweightperft', 'lfweight', 'lfweightft'],
  ['purchasecost', 'cost'],
  ['notes'],
  ['haseverbeencheckedout', 'evercheckedout', 'checkedouthistoryflag'],
  ['lastcheckoutjob', 'checkoutjob', 'lastjob'],
  ['lastcheckoutdate', 'checkoutdate'],
  ['zeroeddate'],
  ['zeroedreason'],
  ['zeroedby']
];

function getRequiredSheetNames_() {
  return [
    'Boxes_IL',
    'Boxes_MS',
    'Zeroed_IL',
    'Zeroed_MS',
    'AuditLog',
    'FILM DATA',
    'ROLL WEIGHT LOG',
    'ALLOCATIONS',
    'FILM ORDERS',
    'FILM ORDER BOXES',
    'JOBS',
    'JOB REQUIREMENTS'
  ];
}

function getSpreadsheet_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  var active = SpreadsheetApp.getActive();
  if (!active) {
    throw new Error('SPREADSHEET_ID script property is required.');
  }

  return active;
}

function validateSheetHeaders_(sheet, expectedHeaders) {
  if (isBoxSheetName_(sheet.getName()) && expectedHeaders === BOX_HEADERS_) {
    buildBoxSheetHeaderMap_(sheet);
    return;
  }

  var actual = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];

  for (var index = 0; index < expectedHeaders.length; index += 1) {
    if (asTrimmedString_(actual[index]) !== expectedHeaders[index]) {
      throw new Error('Sheet ' + sheet.getName() + ' headers do not match the required structure.');
    }
  }
}

function isBoxSheetName_(sheetName) {
  return (
    sheetName === 'Boxes_IL' ||
    sheetName === 'Boxes_MS' ||
    sheetName === 'Zeroed_IL' ||
    sheetName === 'Zeroed_MS'
  );
}

function isLegacyCompatibleBoxSheet_(sheet, actual, expectedHeaders) {
  if (!isBoxSheetName_(sheet.getName()) || expectedHeaders !== BOX_HEADERS_) {
    return false;
  }

  var trailingHeaders = [];

  for (var index = 0; index < expectedHeaders.length; index += 1) {
    var normalizedActual = asTrimmedString_(actual[index]);
    if (index < LEGACY_BOX_HEADER_COUNT_) {
      if (!headerMatchesBoxColumn_(normalizedActual, index)) {
        return false;
      }
      continue;
    }

    if (normalizedActual && !headerMatchesBoxColumn_(normalizedActual, index)) {
      return false;
    }

    trailingHeaders.push(expectedHeaders[index]);
  }

  if (trailingHeaders.length > 0) {
    sheet
      .getRange(1, LEGACY_BOX_HEADER_COUNT_ + 1, 1, trailingHeaders.length)
      .setValues([trailingHeaders]);
  }

  return true;
}

function buildBoxSheetHeaderMap_(sheet) {
  var columnCount = Math.max(sheet.getLastColumn(), 1);
  var actual = sheet.getRange(1, 1, 1, columnCount).getValues()[0];
  var headerMap = {};
  var appendedHeaders = [];
  var normalizedHeaders = actual.slice();
  var didChangeHeaders = false;
  var canonicalHeader;
  var index;

  for (index = 0; index < actual.length; index += 1) {
    canonicalHeader = getCanonicalBoxHeaderForCell_(actual[index]);
    if (canonicalHeader && !headerMap[canonicalHeader]) {
      headerMap[canonicalHeader] = index + 1;
      if (asTrimmedString_(actual[index]) !== canonicalHeader) {
        normalizedHeaders[index] = canonicalHeader;
        didChangeHeaders = true;
      }
    }
  }

  for (index = 0; index < BOX_MINIMUM_REQUIRED_HEADERS_.length; index += 1) {
    canonicalHeader = BOX_MINIMUM_REQUIRED_HEADERS_[index];
    if (!headerMap[canonicalHeader]) {
      throw new Error('Sheet ' + sheet.getName() + ' headers do not match the required structure.');
    }
  }

  for (index = 0; index < BOX_HEADERS_.length; index += 1) {
    canonicalHeader = BOX_HEADERS_[index];
    if (!headerMap[canonicalHeader]) {
      columnCount += 1;
      headerMap[canonicalHeader] = columnCount;
      appendedHeaders.push({
        column: columnCount,
        header: canonicalHeader
      });
    }
  }

  for (index = 0; index < appendedHeaders.length; index += 1) {
    normalizedHeaders[appendedHeaders[index].column - 1] = appendedHeaders[index].header;
    didChangeHeaders = true;
  }

  if (didChangeHeaders) {
    sheet.getRange(1, 1, 1, normalizedHeaders.length).setValues([normalizedHeaders]);
  }

  return {
    headerMap: headerMap,
    columnCount: columnCount
  };
}

function getCanonicalBoxHeaderForCell_(headerText) {
  for (var index = 0; index < BOX_HEADERS_.length; index += 1) {
    if (headerMatchesBoxColumn_(headerText, index)) {
      return BOX_HEADERS_[index];
    }
  }

  return '';
}

function headerMatchesBoxColumn_(actualHeader, headerIndex) {
  var normalized = normalizeHeaderToken_(actualHeader);
  if (!normalized) {
    return false;
  }

  var allowed = BOX_HEADER_ALIASES_BY_INDEX_[headerIndex] || [];

  for (var index = 0; index < allowed.length; index += 1) {
    if (normalized === allowed[index]) {
      return true;
    }
  }

  return normalized === normalizeHeaderToken_(BOX_HEADERS_[headerIndex]);
}

function normalizeHeaderToken_(value) {
  return asTrimmedString_(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getRequiredSheet_(sheetName, expectedHeaders) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Missing sheet: ' + sheetName);
  }

  validateSheetHeaders_(sheet, expectedHeaders);
  return sheet;
}

function getBoxSheetName_(warehouse) {
  return warehouse === 'MS' ? 'Boxes_MS' : 'Boxes_IL';
}

function getZeroedSheetName_(warehouse) {
  return warehouse === 'MS' ? 'Zeroed_MS' : 'Zeroed_IL';
}

function getSheetByWarehouse_(warehouse, useZeroed) {
  var sheetName = useZeroed ? getZeroedSheetName_(warehouse) : getBoxSheetName_(warehouse);
  return getRequiredSheet_(sheetName, BOX_HEADERS_);
}

function getAuditSheet_() {
  return getRequiredSheet_('AuditLog', AUDIT_HEADERS_);
}

function getFilmDataSheet_() {
  return getRequiredSheet_('FILM DATA', FILM_DATA_HEADERS_);
}

function getRollWeightLogSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName('ROLL WEIGHT LOG');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('ROLL WEIGHT LOG');
    sheet.getRange(1, 1, 1, ROLL_WEIGHT_LOG_HEADERS_.length).setValues([ROLL_WEIGHT_LOG_HEADERS_]);
    return sheet;
  }

  validateSheetHeaders_(sheet, ROLL_WEIGHT_LOG_HEADERS_);
  return sheet;
}

function ensureAppendOnlyHeaders_(sheet, legacyHeaders, expectedHeaders) {
  var actualCount = Math.max(sheet.getLastColumn(), legacyHeaders.length, expectedHeaders.length);
  var actual = sheet.getRange(1, 1, 1, actualCount).getValues()[0];
  var index;

  for (index = 0; index < legacyHeaders.length; index += 1) {
    if (asTrimmedString_(actual[index]) !== legacyHeaders[index]) {
      throw new Error('Sheet ' + sheet.getName() + ' headers do not match the required structure.');
    }
  }

  for (index = legacyHeaders.length; index < expectedHeaders.length; index += 1) {
    if (asTrimmedString_(actual[index]) === '') {
      actual[index] = expectedHeaders[index];
    }
  }

  for (index = 0; index < expectedHeaders.length; index += 1) {
    if (asTrimmedString_(actual[index]) !== expectedHeaders[index]) {
      throw new Error('Sheet ' + sheet.getName() + ' headers do not match the required structure.');
    }
  }

  sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([actual.slice(0, expectedHeaders.length)]);
}

function getAllocationsSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName('ALLOCATIONS');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('ALLOCATIONS');
    sheet.getRange(1, 1, 1, ALLOCATIONS_HEADERS_.length).setValues([ALLOCATIONS_HEADERS_]);
    return sheet;
  }

  ensureAppendOnlyHeaders_(sheet, LEGACY_ALLOCATIONS_HEADERS_, ALLOCATIONS_HEADERS_);
  return sheet;
}

function getFilmOrdersSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName('FILM ORDERS');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('FILM ORDERS');
    sheet.getRange(1, 1, 1, FILM_ORDERS_HEADERS_.length).setValues([FILM_ORDERS_HEADERS_]);
    return sheet;
  }

  validateSheetHeaders_(sheet, FILM_ORDERS_HEADERS_);
  return sheet;
}

function getFilmOrderBoxesSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName('FILM ORDER BOXES');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('FILM ORDER BOXES');
    sheet.getRange(1, 1, 1, FILM_ORDER_BOX_LINKS_HEADERS_.length).setValues([FILM_ORDER_BOX_LINKS_HEADERS_]);
    return sheet;
  }

  validateSheetHeaders_(sheet, FILM_ORDER_BOX_LINKS_HEADERS_);
  return sheet;
}

function getJobsSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName('JOBS');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('JOBS');
    sheet.getRange(1, 1, 1, JOBS_HEADERS_.length).setValues([JOBS_HEADERS_]);
    return sheet;
  }

  validateSheetHeaders_(sheet, JOBS_HEADERS_);
  return sheet;
}

function getJobRequirementsSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName('JOB REQUIREMENTS');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('JOB REQUIREMENTS');
    sheet.getRange(1, 1, 1, JOB_REQUIREMENTS_HEADERS_.length).setValues([JOB_REQUIREMENTS_HEADERS_]);
    return sheet;
  }

  validateSheetHeaders_(sheet, JOB_REQUIREMENTS_HEADERS_);
  return sheet;
}

function normalizeSheetDateValue_(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  return asTrimmedString_(value);
}

function normalizeBooleanCell_(value) {
  var normalized = asTrimmedString_(value).toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function getBoxCellByHeader_(row, headerMap, header) {
  var column = headerMap[header];
  if (!column) {
    return '';
  }

  return row[column - 1];
}

function normalizeBoxRow_(row, warehouse, rowIndex, useZeroed, headerMap) {
  var orderDate = normalizeSheetDateValue_(getBoxCellByHeader_(row, headerMap, 'OrderDate'));
  var receivedDate = normalizeSheetDateValue_(getBoxCellByHeader_(row, headerMap, 'ReceivedDate'));
  var lastWeighedDate = normalizeSheetDateValue_(getBoxCellByHeader_(row, headerMap, 'LastWeighedDate'));
  var lastCheckoutDate = normalizeSheetDateValue_(
    getBoxCellByHeader_(row, headerMap, 'LastCheckoutDate')
  );
  var zeroedDate = normalizeSheetDateValue_(getBoxCellByHeader_(row, headerMap, 'ZeroedDate'));

  return {
    boxId: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'BoxID')),
    warehouse: warehouse,
    manufacturer: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'Manufacturer')),
    filmName: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'FilmName')),
    widthIn: Number(getBoxCellByHeader_(row, headerMap, 'WidthIn') || 0),
    initialFeet: Number(getBoxCellByHeader_(row, headerMap, 'InitialFeet') || 0),
    feetAvailable: Number(getBoxCellByHeader_(row, headerMap, 'FeetAvailable') || 0),
    lotRun: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'LotRun')),
    status:
      useZeroed === true
        ? 'ZEROED'
        : deriveStoredStatus_(getBoxCellByHeader_(row, headerMap, 'Status'), receivedDate),
    orderDate: orderDate,
    receivedDate: receivedDate,
    initialWeightLbs:
      asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'InitialWeightLbs')) === ''
        ? null
        : Number(getBoxCellByHeader_(row, headerMap, 'InitialWeightLbs')),
    lastRollWeightLbs:
      asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'LastRollWeightLbs')) === ''
        ? null
        : Number(getBoxCellByHeader_(row, headerMap, 'LastRollWeightLbs')),
    lastWeighedDate: lastWeighedDate,
    filmKey: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'FilmKey')),
    coreType: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'CoreType')),
    coreWeightLbs:
      asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'CoreWeightLbs')) === ''
        ? null
        : Number(getBoxCellByHeader_(row, headerMap, 'CoreWeightLbs')),
    lfWeightLbsPerFt:
      asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'LfWeightLbsPerFt')) === ''
        ? null
        : Number(getBoxCellByHeader_(row, headerMap, 'LfWeightLbsPerFt')),
    purchaseCost:
      asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'PurchaseCost')) === ''
        ? null
        : Number(getBoxCellByHeader_(row, headerMap, 'PurchaseCost')),
    notes: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'Notes')),
    hasEverBeenCheckedOut: normalizeBooleanCell_(
      getBoxCellByHeader_(row, headerMap, 'HasEverBeenCheckedOut')
    ),
    lastCheckoutJob: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'LastCheckoutJob')),
    lastCheckoutDate: lastCheckoutDate,
    zeroedDate: zeroedDate,
    zeroedReason: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'ZeroedReason')),
    zeroedBy: asTrimmedString_(getBoxCellByHeader_(row, headerMap, 'ZeroedBy')),
    rowIndex: rowIndex
  };
}

function buildBoxRowValues_(box, headerMap, columnCount, existingRowValues) {
  var row = existingRowValues ? existingRowValues.slice(0, columnCount) : [];

  while (row.length < columnCount) {
    row.push('');
  }

  function setCell(header, value) {
    var column = headerMap[header];
    if (column) {
      row[column - 1] = value;
    }
  }

  setCell('BoxID', box.boxId);
  setCell('Manufacturer', box.manufacturer);
  setCell('FilmName', box.filmName);
  setCell('WidthIn', box.widthIn);
  setCell('InitialFeet', box.initialFeet);
  setCell('FeetAvailable', box.feetAvailable);
  setCell('LotRun', box.lotRun);
  setCell('Status', box.status);
  setCell('OrderDate', box.orderDate);
  setCell('ReceivedDate', box.receivedDate);
  setCell('InitialWeightLbs', box.initialWeightLbs === null ? '' : box.initialWeightLbs);
  setCell('LastRollWeightLbs', box.lastRollWeightLbs === null ? '' : box.lastRollWeightLbs);
  setCell('LastWeighedDate', box.lastWeighedDate);
  setCell('FilmKey', box.filmKey);
  setCell('CoreType', box.coreType);
  setCell('CoreWeightLbs', box.coreWeightLbs === null ? '' : box.coreWeightLbs);
  setCell('LfWeightLbsPerFt', box.lfWeightLbsPerFt === null ? '' : box.lfWeightLbsPerFt);
  setCell('PurchaseCost', box.purchaseCost === null ? '' : box.purchaseCost);
  setCell('Notes', box.notes);
  setCell('HasEverBeenCheckedOut', box.hasEverBeenCheckedOut === true);
  setCell('LastCheckoutJob', box.lastCheckoutJob);
  setCell('LastCheckoutDate', box.lastCheckoutDate);
  setCell('ZeroedDate', box.zeroedDate);
  setCell('ZeroedReason', box.zeroedReason);
  setCell('ZeroedBy', box.zeroedBy);

  return row;
}

function toPublicBox_(box) {
  var copy = cloneObject_(box);
  if (copy && Object.prototype.hasOwnProperty.call(copy, 'rowIndex')) {
    delete copy.rowIndex;
  }

  return copy;
}

function readSheetBoxes_(warehouse, useZeroed) {
  var sheet = getSheetByWarehouse_(warehouse, useZeroed === true);
  var boxSheetConfig = buildBoxSheetHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, boxSheetConfig.columnCount).getValues();
  var boxes = [];

  for (var index = 0; index < rows.length; index += 1) {
    var box = normalizeBoxRow_(
      rows[index],
      warehouse,
      index + 2,
      useZeroed === true,
      boxSheetConfig.headerMap
    );
    if (box.boxId) {
      boxes.push(box);
    }
  }

  return boxes;
}

function readWarehouseBoxes_(warehouse) {
  return readSheetBoxes_(warehouse, false);
}

function listAllBoxes_() {
  return readWarehouseBoxes_('IL').concat(readWarehouseBoxes_('MS'));
}

function normalizeFilmDataRow_(row, rowIndex) {
  return {
    filmKey: asTrimmedString_(row[0]).toUpperCase(),
    manufacturer: asTrimmedString_(row[1]),
    filmName: asTrimmedString_(row[2]),
    sqFtWeightLbsPerSqFt: asTrimmedString_(row[3]) === '' ? null : Number(row[3]),
    defaultCoreType: asTrimmedString_(row[4]),
    sourceWidthIn: asTrimmedString_(row[5]) === '' ? null : Number(row[5]),
    sourceInitialFeet: asTrimmedString_(row[6]) === '' ? null : Number(row[6]),
    sourceInitialWeightLbs: asTrimmedString_(row[7]) === '' ? null : Number(row[7]),
    updatedAt: asTrimmedString_(row[8]),
    sourceBoxId: asTrimmedString_(row[9]),
    notes: asTrimmedString_(row[10]),
    rowIndex: rowIndex
  };
}

function filmDataToRow_(record) {
  return [
    record.filmKey,
    record.manufacturer,
    record.filmName,
    record.sqFtWeightLbsPerSqFt === null ? '' : record.sqFtWeightLbsPerSqFt,
    record.defaultCoreType,
    record.sourceWidthIn === null ? '' : record.sourceWidthIn,
    record.sourceInitialFeet === null ? '' : record.sourceInitialFeet,
    record.sourceInitialWeightLbs === null ? '' : record.sourceInitialWeightLbs,
    record.updatedAt,
    record.sourceBoxId,
    record.notes
  ];
}

function readFilmData_() {
  var sheet = getFilmDataSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, FILM_DATA_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var record = normalizeFilmDataRow_(rows[index], index + 2);
    if (record.filmKey) {
      entries.push(record);
    }
  }

  return entries;
}

function findFilmDataByFilmKey_(filmKey) {
  var normalizedFilmKey = requireString_(filmKey, 'FilmKey').toUpperCase();
  var entries = readFilmData_();

  for (var index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].filmKey === normalizedFilmKey) {
      return entries[index];
    }
  }

  return null;
}

function upsertFilmDataRecord_(record) {
  var normalized = cloneObject_(record);
  normalized.filmKey = requireString_(normalized.filmKey, 'FilmKey').toUpperCase();
  var existing = findFilmDataByFilmKey_(normalized.filmKey);
  var sheet = getFilmDataSheet_();

  if (existing) {
    normalized.rowIndex = existing.rowIndex;
    sheet
      .getRange(existing.rowIndex, 1, 1, FILM_DATA_HEADERS_.length)
      .setValues([filmDataToRow_(normalized)]);
    return normalized;
  }

  sheet.appendRow(filmDataToRow_(normalized));
  return normalized;
}

function normalizeRollWeightLogRow_(row, rowIndex) {
  return {
    logId: asTrimmedString_(row[0]),
    boxId: asTrimmedString_(row[1]),
    warehouse: asTrimmedString_(row[2]),
    manufacturer: asTrimmedString_(row[3]),
    filmName: asTrimmedString_(row[4]),
    widthIn: asTrimmedString_(row[5]) === '' ? 0 : Number(row[5]),
    jobNumber: asTrimmedString_(row[6]),
    checkedOutAt: asTrimmedString_(row[7]),
    checkedOutBy: asTrimmedString_(row[8]),
    checkedOutWeightLbs: asTrimmedString_(row[9]) === '' ? null : Number(row[9]),
    checkedInAt: asTrimmedString_(row[10]),
    checkedInBy: asTrimmedString_(row[11]),
    checkedInWeightLbs: asTrimmedString_(row[12]) === '' ? null : Number(row[12]),
    weightDeltaLbs: asTrimmedString_(row[13]) === '' ? null : Number(row[13]),
    feetBefore: asTrimmedString_(row[14]) === '' ? 0 : Number(row[14]),
    feetAfter: asTrimmedString_(row[15]) === '' ? 0 : Number(row[15]),
    notes: asTrimmedString_(row[16]),
    rowIndex: rowIndex
  };
}

function rollWeightLogToRow_(entry) {
  return [
    entry.logId,
    entry.boxId,
    entry.warehouse,
    entry.manufacturer,
    entry.filmName,
    entry.widthIn,
    entry.jobNumber,
    entry.checkedOutAt,
    entry.checkedOutBy,
    entry.checkedOutWeightLbs === null ? '' : entry.checkedOutWeightLbs,
    entry.checkedInAt,
    entry.checkedInBy,
    entry.checkedInWeightLbs === null ? '' : entry.checkedInWeightLbs,
    entry.weightDeltaLbs === null ? '' : entry.weightDeltaLbs,
    entry.feetBefore,
    entry.feetAfter,
    entry.notes
  ];
}

function readRollWeightLog_() {
  var sheet = getRollWeightLogSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, ROLL_WEIGHT_LOG_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = normalizeRollWeightLogRow_(rows[index], index + 2);
    if (entry.logId) {
      entries.push(entry);
    }
  }

  return entries;
}

function readRollWeightLogByBox_(boxId) {
  var normalizedBoxId = requireString_(boxId, 'BoxID');
  var allEntries = readRollWeightLog_();
  var filtered = [];

  for (var index = allEntries.length - 1; index >= 0; index -= 1) {
    if (allEntries[index].boxId === normalizedBoxId) {
      filtered.push(allEntries[index]);
    }
  }

  return filtered;
}

function appendRollWeightLog_(entry) {
  var sheet = getRollWeightLogSheet_();
  var normalized = cloneObject_(entry);
  if (!normalized.logId) {
    normalized.logId = createLogId_();
  }

  sheet.appendRow(rollWeightLogToRow_(normalized));
  return normalized.logId;
}

function findRowByBoxIdAcrossWarehouses_(boxId, includeZeroed) {
  var normalizedBoxId = requireString_(boxId, 'BoxID');
  var warehouses = ['IL', 'MS'];
  var searchZeroed = includeZeroed === true;

  for (var sheetIndex = 0; sheetIndex < (searchZeroed ? 2 : 1); sheetIndex += 1) {
    var useZeroed = sheetIndex === 1;

    for (var index = 0; index < warehouses.length; index += 1) {
      var warehouse = warehouses[index];
      var boxes = readSheetBoxes_(warehouse, useZeroed);

      for (var boxIndex = 0; boxIndex < boxes.length; boxIndex += 1) {
        if (boxes[boxIndex].boxId === normalizedBoxId) {
          return {
            warehouse: warehouse,
            rowIndex: boxes[boxIndex].rowIndex,
            box: boxes[boxIndex],
            useZeroed: useZeroed
          };
        }
      }
    }
  }

  return null;
}

function findZeroedRowByBoxIdAcrossWarehouses_(boxId) {
  var normalizedBoxId = requireString_(boxId, 'BoxID');
  var warehouses = ['IL', 'MS'];

  for (var index = 0; index < warehouses.length; index += 1) {
    var warehouse = warehouses[index];
    var boxes = readSheetBoxes_(warehouse, true);

    for (var boxIndex = 0; boxIndex < boxes.length; boxIndex += 1) {
      if (boxes[boxIndex].boxId === normalizedBoxId) {
        return {
          warehouse: warehouse,
          rowIndex: boxes[boxIndex].rowIndex,
          box: boxes[boxIndex],
          useZeroed: true
        };
      }
    }
  }

  return null;
}

function appendBoxRow_(warehouse, box, useZeroed) {
  var sheet = getSheetByWarehouse_(warehouse, useZeroed === true);
  var boxSheetConfig = buildBoxSheetHeaderMap_(sheet);
  sheet.appendRow(buildBoxRowValues_(box, boxSheetConfig.headerMap, boxSheetConfig.columnCount));
  return sheet.getLastRow();
}

function updateBoxRow_(warehouse, rowIndex, box, useZeroed) {
  var sheet = getSheetByWarehouse_(warehouse, useZeroed === true);
  var boxSheetConfig = buildBoxSheetHeaderMap_(sheet);
  var existingRow = sheet.getRange(rowIndex, 1, 1, boxSheetConfig.columnCount).getValues()[0];
  sheet
    .getRange(rowIndex, 1, 1, boxSheetConfig.columnCount)
    .setValues([
      buildBoxRowValues_(box, boxSheetConfig.headerMap, boxSheetConfig.columnCount, existingRow)
    ]);
}

function deleteBoxRow_(warehouse, rowIndex, useZeroed) {
  var sheet = getSheetByWarehouse_(warehouse, useZeroed === true);
  sheet.deleteRow(rowIndex);
}

function normalizeAllocationRow_(row, rowIndex) {
  return {
    allocationId: asTrimmedString_(row[0]),
    boxId: asTrimmedString_(row[1]),
    warehouse: asTrimmedString_(row[2]),
    jobNumber: asTrimmedString_(row[3]),
    jobDate: normalizeSheetDateValue_(row[4]),
    allocatedFeet: asTrimmedString_(row[5]) === '' ? 0 : Number(row[5]),
    status: asTrimmedString_(row[6]) || 'ACTIVE',
    createdAt: asTrimmedString_(row[7]),
    createdBy: asTrimmedString_(row[8]),
    resolvedAt: asTrimmedString_(row[9]),
    resolvedBy: asTrimmedString_(row[10]),
    notes: asTrimmedString_(row[11]),
    crewLeader: asTrimmedString_(row[12]),
    filmOrderId: asTrimmedString_(row[13]),
    rowIndex: rowIndex
  };
}

function allocationToRow_(allocation) {
  return [
    allocation.allocationId,
    allocation.boxId,
    allocation.warehouse,
    allocation.jobNumber,
    allocation.jobDate,
    allocation.allocatedFeet,
    allocation.status,
    allocation.createdAt,
    allocation.createdBy,
    allocation.resolvedAt,
    allocation.resolvedBy,
    allocation.notes,
    allocation.crewLeader,
    allocation.filmOrderId
  ];
}

function readAllocations_() {
  var sheet = getAllocationsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, ALLOCATIONS_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = normalizeAllocationRow_(rows[index], index + 2);
    if (entry.allocationId) {
      entries.push(entry);
    }
  }

  return entries;
}

function readAllocationsByBox_(boxId) {
  var normalizedBoxId = requireString_(boxId, 'BoxID');
  var allocations = readAllocations_();
  var filtered = [];

  for (var index = allocations.length - 1; index >= 0; index -= 1) {
    if (allocations[index].boxId === normalizedBoxId) {
      filtered.push(allocations[index]);
    }
  }

  return filtered;
}

function readAllocationsByJob_(jobNumber) {
  var normalizedJobNumber = requireString_(jobNumber, 'JobNumber').toUpperCase();
  var allocations = readAllocations_();
  var filtered = [];

  for (var index = allocations.length - 1; index >= 0; index -= 1) {
    if (asTrimmedString_(allocations[index].jobNumber).toUpperCase() === normalizedJobNumber) {
      filtered.push(allocations[index]);
    }
  }

  return filtered;
}

function readAllocationsByFilmOrderId_(filmOrderId) {
  var normalizedFilmOrderId = requireString_(filmOrderId, 'FilmOrderID');
  var allocations = readAllocations_();
  var filtered = [];

  for (var index = allocations.length - 1; index >= 0; index -= 1) {
    if (allocations[index].filmOrderId === normalizedFilmOrderId) {
      filtered.push(allocations[index]);
    }
  }

  return filtered;
}

function appendAllocation_(allocation) {
  var sheet = getAllocationsSheet_();
  var normalized = cloneObject_(allocation);
  if (!normalized.allocationId) {
    normalized.allocationId = createLogId_();
  }

  sheet.appendRow(allocationToRow_(normalized));
  return normalized;
}

function updateAllocationRow_(rowIndex, allocation) {
  var sheet = getAllocationsSheet_();
  sheet.getRange(rowIndex, 1, 1, ALLOCATIONS_HEADERS_.length).setValues([allocationToRow_(allocation)]);
}

function normalizeFilmOrderRow_(row, rowIndex) {
  return {
    filmOrderId: asTrimmedString_(row[0]),
    jobNumber: asTrimmedString_(row[1]),
    warehouse: asTrimmedString_(row[2]),
    manufacturer: asTrimmedString_(row[3]),
    filmName: asTrimmedString_(row[4]),
    widthIn: asTrimmedString_(row[5]) === '' ? 0 : Number(row[5]),
    requestedFeet: asTrimmedString_(row[6]) === '' ? 0 : Number(row[6]),
    coveredFeet: asTrimmedString_(row[7]) === '' ? 0 : Number(row[7]),
    orderedFeet: asTrimmedString_(row[8]) === '' ? 0 : Number(row[8]),
    remainingToOrderFeet: asTrimmedString_(row[9]) === '' ? 0 : Number(row[9]),
    jobDate: normalizeSheetDateValue_(row[10]),
    crewLeader: asTrimmedString_(row[11]),
    status: asTrimmedString_(row[12]) || 'FILM_ORDER',
    sourceBoxId: asTrimmedString_(row[13]),
    createdAt: asTrimmedString_(row[14]),
    createdBy: asTrimmedString_(row[15]),
    resolvedAt: asTrimmedString_(row[16]),
    resolvedBy: asTrimmedString_(row[17]),
    notes: asTrimmedString_(row[18]),
    rowIndex: rowIndex
  };
}

function filmOrderToRow_(entry) {
  return [
    entry.filmOrderId,
    entry.jobNumber,
    entry.warehouse,
    entry.manufacturer,
    entry.filmName,
    entry.widthIn,
    entry.requestedFeet,
    entry.coveredFeet,
    entry.orderedFeet,
    entry.remainingToOrderFeet,
    entry.jobDate,
    entry.crewLeader,
    entry.status,
    entry.sourceBoxId,
    entry.createdAt,
    entry.createdBy,
    entry.resolvedAt,
    entry.resolvedBy,
    entry.notes
  ];
}

function readFilmOrders_() {
  var sheet = getFilmOrdersSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, FILM_ORDERS_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = normalizeFilmOrderRow_(rows[index], index + 2);
    if (entry.filmOrderId) {
      entries.push(entry);
    }
  }

  return entries;
}

function findFilmOrderById_(filmOrderId) {
  var normalized = requireString_(filmOrderId, 'FilmOrderID');
  var orders = readFilmOrders_();

  for (var index = orders.length - 1; index >= 0; index -= 1) {
    if (orders[index].filmOrderId === normalized) {
      return orders[index];
    }
  }

  return null;
}

function readFilmOrdersByJob_(jobNumber) {
  var normalized = requireString_(jobNumber, 'JobNumber').toUpperCase();
  var orders = readFilmOrders_();
  var filtered = [];

  for (var index = orders.length - 1; index >= 0; index -= 1) {
    if (asTrimmedString_(orders[index].jobNumber).toUpperCase() === normalized) {
      filtered.push(orders[index]);
    }
  }

  return filtered;
}

function appendFilmOrder_(entry) {
  var sheet = getFilmOrdersSheet_();
  var normalized = cloneObject_(entry);
  if (!normalized.filmOrderId) {
    normalized.filmOrderId = createLogId_();
  }

  sheet.appendRow(filmOrderToRow_(normalized));
  return normalized;
}

function updateFilmOrderRow_(rowIndex, entry) {
  var sheet = getFilmOrdersSheet_();
  sheet.getRange(rowIndex, 1, 1, FILM_ORDERS_HEADERS_.length).setValues([filmOrderToRow_(entry)]);
}

function normalizeJobRow_(row, rowIndex) {
  var sections = normalizeSectionsCellValue_(row[2]);
  return {
    jobNumber: asTrimmedString_(row[0]),
    warehouse: asTrimmedString_(row[1]).toUpperCase(),
    sections: sections,
    dueDate: normalizeSheetDateValue_(row[3]),
    lifecycleStatus: asTrimmedString_(row[4]).toUpperCase() || 'ACTIVE',
    createdAt: asTrimmedString_(row[5]),
    createdBy: asTrimmedString_(row[6]),
    updatedAt: asTrimmedString_(row[7]),
    updatedBy: asTrimmedString_(row[8]),
    notes: asTrimmedString_(row[9]),
    rowIndex: rowIndex
  };
}

function normalizeSectionsCellValue_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) {
      return null;
    }

    return [String(value.getMonth() + 1), String(value.getDate()), String(value.getFullYear())].join(', ');
  }

  var text = asTrimmedString_(value);
  if (!text) {
    return null;
  }

  var tokens = text.split(',');
  var normalizedTokens = [];
  for (var index = 0; index < tokens.length; index += 1) {
    var token = asTrimmedString_(tokens[index]);
    if (!token) {
      continue;
    }

    if (!/^\d+$/.test(token)) {
      return null;
    }

    normalizedTokens.push(token);
  }

  if (!normalizedTokens.length) {
    return null;
  }

  return normalizedTokens.join(', ');
}

function jobToRow_(entry) {
  return [
    entry.jobNumber,
    entry.warehouse,
    entry.sections === null || entry.sections === undefined ? '' : entry.sections,
    entry.dueDate,
    entry.lifecycleStatus,
    entry.createdAt,
    entry.createdBy,
    entry.updatedAt,
    entry.updatedBy,
    entry.notes
  ];
}

function writeJobRow_(sheet, rowIndex, entry) {
  var row = jobToRow_(entry);
  var sectionsValue = asTrimmedString_(row[2]);

  row[2] = '';
  sheet.getRange(rowIndex, 1, 1, JOBS_HEADERS_.length).setValues([row]);

  var sectionsCell = sheet.getRange(rowIndex, 3);
  sectionsCell.setNumberFormat('@');
  sectionsCell.setValue(sectionsValue);
}

function readJobs_() {
  var sheet = getJobsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, JOBS_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = normalizeJobRow_(rows[index], index + 2);
    if (entry.jobNumber) {
      entries.push(entry);
    }
  }

  return entries;
}

function findJobByNumber_(jobNumber) {
  var normalized = requireString_(jobNumber, 'JobNumber');
  var jobs = readJobs_();

  for (var index = jobs.length - 1; index >= 0; index -= 1) {
    if (jobs[index].jobNumber === normalized) {
      return jobs[index];
    }
  }

  return null;
}

function appendJob_(entry) {
  var sheet = getJobsSheet_();
  var normalized = cloneObject_(entry);
  normalized.rowIndex = sheet.getLastRow() + 1;
  writeJobRow_(sheet, normalized.rowIndex, normalized);
  return normalized;
}

function updateJobRow_(rowIndex, entry) {
  var sheet = getJobsSheet_();
  writeJobRow_(sheet, rowIndex, entry);
}

function normalizeJobRequirementRow_(row, rowIndex) {
  return {
    requirementId: asTrimmedString_(row[0]),
    jobNumber: asTrimmedString_(row[1]),
    manufacturer: asTrimmedString_(row[2]),
    filmName: asTrimmedString_(row[3]),
    widthIn: asTrimmedString_(row[4]) === '' ? 0 : Number(row[4]),
    requiredFeet: asTrimmedString_(row[5]) === '' ? 0 : Number(row[5]),
    createdAt: asTrimmedString_(row[6]),
    createdBy: asTrimmedString_(row[7]),
    updatedAt: asTrimmedString_(row[8]),
    updatedBy: asTrimmedString_(row[9]),
    notes: asTrimmedString_(row[10]),
    rowIndex: rowIndex
  };
}

function jobRequirementToRow_(entry) {
  return [
    entry.requirementId,
    entry.jobNumber,
    entry.manufacturer,
    entry.filmName,
    entry.widthIn,
    entry.requiredFeet,
    entry.createdAt,
    entry.createdBy,
    entry.updatedAt,
    entry.updatedBy,
    entry.notes
  ];
}

function readJobRequirements_() {
  var sheet = getJobRequirementsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, JOB_REQUIREMENTS_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = normalizeJobRequirementRow_(rows[index], index + 2);
    if (entry.requirementId && entry.jobNumber) {
      entries.push(entry);
    }
  }

  return entries;
}

function readJobRequirementsByJob_(jobNumber) {
  var normalized = requireString_(jobNumber, 'JobNumber').toUpperCase();
  var entries = readJobRequirements_();
  var filtered = [];

  for (var index = entries.length - 1; index >= 0; index -= 1) {
    if (asTrimmedString_(entries[index].jobNumber).toUpperCase() === normalized) {
      filtered.push(entries[index]);
    }
  }

  return filtered;
}

function appendJobRequirement_(entry) {
  var sheet = getJobRequirementsSheet_();
  var normalized = cloneObject_(entry);
  if (!normalized.requirementId) {
    normalized.requirementId = createLogId_();
  }

  sheet.appendRow(jobRequirementToRow_(normalized));
  normalized.rowIndex = sheet.getLastRow();
  return normalized;
}

function deleteJobRequirementRow_(rowIndex) {
  var sheet = getJobRequirementsSheet_();
  sheet.deleteRow(rowIndex);
}

function replaceJobRequirementsForJob_(jobNumber, entries) {
  var existing = readJobRequirementsByJob_(jobNumber);

  existing.sort(function(a, b) {
    return b.rowIndex - a.rowIndex;
  });

  for (var index = 0; index < existing.length; index += 1) {
    deleteJobRequirementRow_(existing[index].rowIndex);
  }

  for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    appendJobRequirement_(entries[entryIndex]);
  }
}

function normalizeFilmOrderBoxLinkRow_(row, rowIndex) {
  return {
    linkId: asTrimmedString_(row[0]),
    filmOrderId: asTrimmedString_(row[1]),
    boxId: asTrimmedString_(row[2]),
    orderedFeet: asTrimmedString_(row[3]) === '' ? 0 : Number(row[3]),
    autoAllocatedFeet: asTrimmedString_(row[4]) === '' ? 0 : Number(row[4]),
    createdAt: asTrimmedString_(row[5]),
    createdBy: asTrimmedString_(row[6]),
    rowIndex: rowIndex
  };
}

function filmOrderBoxLinkToRow_(entry) {
  return [
    entry.linkId,
    entry.filmOrderId,
    entry.boxId,
    entry.orderedFeet,
    entry.autoAllocatedFeet,
    entry.createdAt,
    entry.createdBy
  ];
}

function readFilmOrderBoxLinks_() {
  var sheet = getFilmOrderBoxesSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, FILM_ORDER_BOX_LINKS_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = normalizeFilmOrderBoxLinkRow_(rows[index], index + 2);
    if (entry.linkId) {
      entries.push(entry);
    }
  }

  return entries;
}

function readFilmOrderBoxLinksByFilmOrderId_(filmOrderId) {
  var normalized = requireString_(filmOrderId, 'FilmOrderID');
  var links = readFilmOrderBoxLinks_();
  var filtered = [];

  for (var index = links.length - 1; index >= 0; index -= 1) {
    if (links[index].filmOrderId === normalized) {
      filtered.push(links[index]);
    }
  }

  return filtered;
}

function readFilmOrderBoxLinksByBoxId_(boxId) {
  var normalized = requireString_(boxId, 'BoxID');
  var links = readFilmOrderBoxLinks_();
  var filtered = [];

  for (var index = links.length - 1; index >= 0; index -= 1) {
    if (links[index].boxId === normalized) {
      filtered.push(links[index]);
    }
  }

  return filtered;
}

function appendFilmOrderBoxLink_(entry) {
  var sheet = getFilmOrderBoxesSheet_();
  var normalized = cloneObject_(entry);
  if (!normalized.linkId) {
    normalized.linkId = createLogId_();
  }

  sheet.appendRow(filmOrderBoxLinkToRow_(normalized));
  return normalized;
}

function updateFilmOrderBoxLinkRow_(rowIndex, entry) {
  var sheet = getFilmOrderBoxesSheet_();
  sheet
    .getRange(rowIndex, 1, 1, FILM_ORDER_BOX_LINKS_HEADERS_.length)
    .setValues([filmOrderBoxLinkToRow_(entry)]);
}


// Paste into Apps Script file: boxes.gs

function determineWarehouseFromBoxId_(boxId) {
  return requireString_(boxId, 'BoxID').charAt(0).toUpperCase() === 'M' ? 'MS' : 'IL';
}

function buildFilmKey_(manufacturer, filmName) {
  return manufacturer.toUpperCase() + '|' + filmName.toUpperCase();
}

function getTodayDateString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function deriveAddFeetAvailable_(initialFeet, receivedDate) {
  return receivedDate && receivedDate <= getTodayDateString_() ? initialFeet : 0;
}

function deriveLifecycleStatus_(receivedDate) {
  return receivedDate && receivedDate <= getTodayDateString_() ? 'IN_STOCK' : 'ORDERED';
}

function deriveStoredStatus_(statusValue, receivedDate) {
  var stored = asTrimmedString_(statusValue);
  if (!stored) {
    return deriveLifecycleStatus_(receivedDate);
  }

  return assertBoxStatus_(stored);
}

var CORE_WEIGHT_REFERENCE_WIDTH_IN_ = 72;
var CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS_ = {
  White: 2,
  Red: 1.85,
  Cardboard: 2.05
};
var LOW_STOCK_THRESHOLD_LF_ = 10;

function roundToDecimals_(value, decimals) {
  var factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function normalizeCoreType_(value, allowBlank) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new Error('CoreType is required.');
  }

  var normalized = trimmed.toLowerCase();
  if (normalized === 'white') {
    return 'White';
  }

  if (normalized === 'red') {
    return 'Red';
  }

  if (normalized === 'cardboard') {
    return 'Cardboard';
  }

  throw new Error('CoreType must be White, Red, or Cardboard.');
}

function deriveCoreWeightLbs_(coreType, widthIn) {
  return roundToDecimals_(
    (CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS_[coreType] / CORE_WEIGHT_REFERENCE_WIDTH_IN_) * widthIn,
    4
  );
}

function deriveLfWeightLbsPerFt_(sqFtWeightLbsPerSqFt, widthIn) {
  return roundToDecimals_(sqFtWeightLbsPerSqFt * (widthIn / 12), 6);
}

function deriveInitialWeightLbs_(lfWeightLbsPerFt, initialFeet, coreWeightLbs) {
  return roundToDecimals_(lfWeightLbsPerFt * initialFeet + coreWeightLbs, 2);
}

function deriveSqFtWeightLbsPerSqFt_(initialWeightLbs, coreWeightLbs, widthIn, initialFeet) {
  var areaSqFt = (widthIn / 12) * initialFeet;
  if (areaSqFt <= 0) {
    throw new Error('WidthIn and InitialFeet must be greater than zero to derive film weight.');
  }

  var filmOnlyWeightLbs = initialWeightLbs - coreWeightLbs;
  if (filmOnlyWeightLbs < 0) {
    throw new Error('InitialWeightLbs must be greater than or equal to the derived core weight.');
  }

  return roundToDecimals_(filmOnlyWeightLbs / areaSqFt, 8);
}

function deriveFeetAvailableFromRollWeight_(lastRollWeightLbs, coreWeightLbs, lfWeightLbsPerFt, initialFeet) {
  if (lfWeightLbsPerFt <= 0) {
    throw new Error('LfWeightLbsPerFt must be greater than zero to calculate FeetAvailable.');
  }

  var rawFeet = (lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt;
  if (rawFeet <= 0) {
    return 0;
  }

  var flooredFeet = Math.floor(rawFeet);
  if (flooredFeet > initialFeet) {
    return initialFeet;
  }

  return flooredFeet;
}

function isLowStockBox_(box) {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < LOW_STOCK_THRESHOLD_LF_;
}

function hasPositivePhysicalFeet_(box) {
  if (!box || !box.receivedDate) {
    return false;
  }

  if (
    box.lastRollWeightLbs !== null &&
    box.coreWeightLbs !== null &&
    box.lfWeightLbsPerFt !== null &&
    box.lfWeightLbsPerFt > 0
  ) {
    return (
      deriveFeetAvailableFromRollWeight_(
        box.lastRollWeightLbs,
        box.coreWeightLbs,
        box.lfWeightLbsPerFt,
        box.initialFeet
      ) > 0
    );
  }

  return box.initialFeet > 0;
}

function shouldAutoMoveToZeroed_(existingBox, nextBox) {
  return (
    Boolean(nextBox.receivedDate) &&
    existingBox &&
    hasPositivePhysicalFeet_(existingBox) &&
    (nextBox.feetAvailable === 0 || nextBox.lastRollWeightLbs === 0)
  );
}

function determineZeroedReason_(box) {
  if (box.feetAvailable === 0 && box.lastRollWeightLbs === 0) {
    return 'Auto-zeroed because Available Feet and Last Roll Weight reached 0.';
  }

  if (box.feetAvailable === 0) {
    return 'Auto-zeroed because Available Feet reached 0.';
  }

  return 'Auto-zeroed because Last Roll Weight reached 0.';
}

function normalizeMeaningfulZeroedNote_(note) {
  var trimmed = asTrimmedString_(note);
  if (!trimmed) {
    return '';
  }

  if (
    /^Checked in at /i.test(trimmed) ||
    /^Auto-moved to zeroed out inventory$/i.test(trimmed)
  ) {
    return '';
  }

  return trimmed;
}

function stampZeroedMetadata_(box, user, auditNote) {
  var note = normalizeMeaningfulZeroedNote_(auditNote);
  box.status = 'ZEROED';
  box.feetAvailable = 0;
  box.zeroedDate = getTodayDateString_();
  box.zeroedReason = determineZeroedReason_(box) + (note ? ' Additional note: ' + note : '');
  box.zeroedBy = asTrimmedString_(user);
}

function applyAddOrEditWarnings_(warnings, currentBox, nextBox) {
  if (nextBox.receivedDate && nextBox.orderDate && nextBox.receivedDate < nextBox.orderDate) {
    warnings.push('Received Date is earlier than Order Date.');
  }

  if (
    nextBox.lastWeighedDate &&
    nextBox.receivedDate &&
    nextBox.lastWeighedDate < nextBox.receivedDate
  ) {
    warnings.push('Last Weighed Date is earlier than Received Date.');
  }

  if (nextBox.feetAvailable > nextBox.initialFeet) {
    warnings.push('Available Feet is greater than Initial Feet.');
  }

  if (
    nextBox.receivedDate &&
    nextBox.feetAvailable === 0 &&
    nextBox.lastRollWeightLbs !== null &&
    nextBox.lastRollWeightLbs > 0
  ) {
    warnings.push('Available Feet is 0 while Last Roll Weight is still above 0.');
  }

  if (nextBox.receivedDate && nextBox.lastRollWeightLbs === 0 && nextBox.feetAvailable > 0) {
    warnings.push('Last Roll Weight is 0 while Available Feet is still above 0.');
  }

  if (
    currentBox &&
    currentBox.receivedDate &&
    (currentBox.initialWeightLbs !== null ||
      currentBox.lastRollWeightLbs !== null ||
      currentBox.lfWeightLbsPerFt !== null) &&
    (currentBox.manufacturer !== nextBox.manufacturer ||
      currentBox.filmName !== nextBox.filmName ||
      currentBox.widthIn !== nextBox.widthIn ||
      currentBox.initialFeet !== nextBox.initialFeet)
  ) {
    warnings.push('Film identity, width, or initial feet changed after weights were already established.');
  }
}

function applyCheckoutWarnings_(warnings, box) {
  if (box.lastRollWeightLbs === null) {
    warnings.push('This box does not have a current Last Roll Weight saved yet.');
  }

  if (!box.lastWeighedDate) {
    warnings.push('This box does not have a Last Weighed Date saved yet.');
  }
}

function applyCheckInWarnings_(warnings, existingBox, updatedBox, willAutoZero) {
  if (
    existingBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.lastRollWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box’s previous Last Roll Weight.');
  }

  if (
    existingBox.initialWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.initialWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box’s Initial Weight.');
  }

  if (
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > 0 &&
    updatedBox.coreWeightLbs !== null &&
    updatedBox.lastRollWeightLbs < updatedBox.coreWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is below the derived core weight.');
  }

  if (updatedBox.feetAvailable > existingBox.feetAvailable) {
    warnings.push('The recalculated Available Feet would increase compared with the current box.');
  }

  if (willAutoZero) {
    warnings.push('This check-in will auto-move the box into zeroed out inventory.');
  }
}

function getActiveAllocationsForBox_(boxId) {
  var entries = readAllocationsByBox_(boxId);
  var active = [];

  for (var index = 0; index < entries.length; index += 1) {
    if (entries[index].status === 'ACTIVE') {
      active.push(entries[index]);
    }
  }

  return active;
}

function getActiveAllocatedFeetForBox_(boxId) {
  var active = getActiveAllocationsForBox_(boxId);
  var total = 0;

  for (var index = 0; index < active.length; index += 1) {
    total += active[index].allocatedFeet;
  }

  return total;
}

function normalizeJobNumberKey_(jobNumber) {
  return asTrimmedString_(jobNumber).toUpperCase();
}

function resolveAllocationsForCheckout_(boxId, jobNumber, user) {
  var active = getActiveAllocationsForBox_(boxId);
  var normalizedJobNumber = normalizeJobNumberKey_(jobNumber);
  var resolvedAt = new Date().toISOString();
  var result = {
    fulfilledCount: 0,
    fulfilledFeet: 0,
    otherJobs: []
  };
  var otherJobs = {};

  for (var index = 0; index < active.length; index += 1) {
    var entry = cloneObject_(active[index]);
    if (normalizeJobNumberKey_(entry.jobNumber) === normalizedJobNumber) {
      entry.status = 'FULFILLED';
      entry.resolvedAt = resolvedAt;
      entry.resolvedBy = asTrimmedString_(user);
      entry.notes = 'Fulfilled by checkout for job ' + jobNumber + '.';
      updateAllocationRow_(entry.rowIndex, entry);
      result.fulfilledCount += 1;
      result.fulfilledFeet += entry.allocatedFeet;
      continue;
    }

    if (entry.jobNumber && !otherJobs[entry.jobNumber]) {
      otherJobs[entry.jobNumber] = true;
      result.otherJobs.push(entry.jobNumber);
    }
  }

  return result;
}

function cancelActiveAllocationsForBox_(boxId, user, reason) {
  var active = getActiveAllocationsForBox_(boxId);
  var resolvedAt = new Date().toISOString();
  var trimmedReason = asTrimmedString_(reason);
  var affectedFilmOrders = {};

  for (var index = 0; index < active.length; index += 1) {
    var entry = cloneObject_(active[index]);
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString_(user);
    entry.notes = trimmedReason || entry.notes;
    updateAllocationRow_(entry.rowIndex, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }
  }

  for (var filmOrderId in affectedFilmOrders) {
    if (Object.prototype.hasOwnProperty.call(affectedFilmOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, user);
    }
  }

  return active.length;
}

function reactivateFulfilledAllocationsForUndo_(boxId, jobNumber) {
  var entries = readAllocationsByBox_(boxId);
  var expectedNote = 'Fulfilled by checkout for job ' + jobNumber + '.';
  var count = 0;

  for (var index = 0; index < entries.length; index += 1) {
    var entry = cloneObject_(entries[index]);
    if (
      entry.status === 'FULFILLED' &&
      normalizeJobNumberKey_(entry.jobNumber) === normalizeJobNumberKey_(jobNumber) &&
      entry.notes === expectedNote
    ) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      updateAllocationRow_(entry.rowIndex, entry);
      count += 1;
    }
  }

  return count;
}

function reactivateCancelledAllocationsForZeroUndo_(boxId) {
  var entries = readAllocationsByBox_(boxId);
  var expectedNote = 'Auto-cancelled because the box was moved to zeroed out inventory.';
  var count = 0;
  var affectedFilmOrders = {};

  for (var index = 0; index < entries.length; index += 1) {
    var entry = cloneObject_(entries[index]);
    if (entry.status === 'CANCELLED' && entry.notes === expectedNote) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      updateAllocationRow_(entry.rowIndex, entry);
      if (entry.filmOrderId) {
        affectedFilmOrders[entry.filmOrderId] = true;
      }
      count += 1;
    }
  }

  for (var filmOrderId in affectedFilmOrders) {
    if (Object.prototype.hasOwnProperty.call(affectedFilmOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, '');
    }
  }

  return count;
}

function normalizeCrewLeaderKey_(crewLeader) {
  return asTrimmedString_(crewLeader).toUpperCase();
}

function resolveJobContext_(jobNumber, jobDate, crewLeader) {
  var normalizedJobNumber = requireString_(jobNumber, 'JobNumber');
  var normalizedJobDate = normalizeDateString_(jobDate, 'JobDate', true);
  var normalizedCrewLeader = asTrimmedString_(crewLeader);
  var existingAllocations = readAllocationsByJob_(normalizedJobNumber);
  var existingFilmOrders = readFilmOrdersByJob_(normalizedJobNumber);
  var existingJobDate = '';
  var existingCrewLeader = '';
  var index;

  for (index = 0; index < existingAllocations.length; index += 1) {
    if (!existingJobDate && existingAllocations[index].jobDate) {
      existingJobDate = existingAllocations[index].jobDate;
    }

    if (!existingCrewLeader && existingAllocations[index].crewLeader) {
      existingCrewLeader = existingAllocations[index].crewLeader;
    }
  }

  for (index = 0; index < existingFilmOrders.length; index += 1) {
    if (!existingJobDate && existingFilmOrders[index].jobDate) {
      existingJobDate = existingFilmOrders[index].jobDate;
    }

    if (!existingCrewLeader && existingFilmOrders[index].crewLeader) {
      existingCrewLeader = existingFilmOrders[index].crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new Error('JobDate must stay the same for an existing Job Number.');
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey_(existingCrewLeader) !== normalizeCrewLeaderKey_(normalizedCrewLeader)
  ) {
    throw new Error('CrewLeader must stay the same for an existing Job Number.');
  }

  var resolvedJobDate = normalizedJobDate || existingJobDate;
  var resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;

  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new Error('CrewLeader is required when JobDate is set.');
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader
  };
}

function getDateConflictJobsForBox_(boxId, jobContext) {
  if (!jobContext.jobDate) {
    return [];
  }

  var active = getActiveAllocationsForBox_(boxId);
  var conflicts = [];
  var seen = {};

  for (var index = 0; index < active.length; index += 1) {
    var entry = active[index];
    if (
      entry.jobDate !== jobContext.jobDate ||
      normalizeJobNumberKey_(entry.jobNumber) === normalizeJobNumberKey_(jobContext.jobNumber)
    ) {
      continue;
    }

    if (normalizeCrewLeaderKey_(entry.crewLeader) === normalizeCrewLeaderKey_(jobContext.crewLeader)) {
      continue;
    }

    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }

  return conflicts;
}

function compareBoxesByOldestStock_(a, b) {
  var aDate = a.receivedDate || a.orderDate || '9999-12-31';
  var bDate = b.receivedDate || b.orderDate || '9999-12-31';

  if (aDate !== bDate) {
    return aDate < bDate ? -1 : 1;
  }

  return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
}

function buildAllocationPreviewPlan_(sourceBox, requestedFeet, jobContext, options) {
  var requested = coerceFeetValue_(requestedFeet, 'RequestedFeet', [], true);
  if (requested <= 0) {
    throw new Error('RequestedFeet must be greater than zero.');
  }

  var useCrossWarehouse = options && options.crossWarehouse === true;
  var sourceConflicts = getDateConflictJobsForBox_(sourceBox.boxId, jobContext);
  var sourceAllocationFeet = sourceConflicts.length ? 0 : Math.min(sourceBox.feetAvailable, requested);
  var remaining = requested - sourceAllocationFeet;
  var candidates = [];
  var candidateBoxes = useCrossWarehouse ? listAllBoxes_() : readWarehouseBoxes_(sourceBox.warehouse);

  candidateBoxes.sort(compareBoxesByOldestStock_);

  for (var index = 0; index < candidateBoxes.length; index += 1) {
    var candidate = candidateBoxes[index];
    if (
      candidate.boxId === sourceBox.boxId ||
      candidate.status !== 'IN_STOCK' ||
      candidate.feetAvailable <= 0 ||
      candidate.manufacturer !== sourceBox.manufacturer ||
      candidate.filmName !== sourceBox.filmName ||
      candidate.widthIn !== sourceBox.widthIn
    ) {
      continue;
    }

    var candidateConflicts = getDateConflictJobsForBox_(candidate.boxId, jobContext);
    if (candidateConflicts.length) {
      continue;
    }

    candidates.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      availableFeet: candidate.feetAvailable,
      suggestedFeet: remaining > 0 ? Math.min(candidate.feetAvailable, remaining) : 0,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate
    });

    if (remaining > 0) {
      remaining -= Math.min(candidate.feetAvailable, remaining);
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceSuggestedFeet: sourceAllocationFeet,
    sourceConflicts: sourceConflicts,
    suggestions: candidates,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining
  };
}

function calculateSelectedSuggestionAllocations_(plan, selectedBoxIds) {
  var selectedMap = {};
  var allocations = [];
  var remaining = plan.requestedFeet;
  var index;

  if (plan.sourceSuggestedFeet > 0) {
    allocations.push({
      boxId: plan.sourceBoxId,
      allocatedFeet: plan.sourceSuggestedFeet
    });
    remaining -= plan.sourceSuggestedFeet;
  }

  for (index = 0; index < selectedBoxIds.length; index += 1) {
    selectedMap[selectedBoxIds[index]] = true;
  }

  for (index = 0; index < plan.suggestions.length; index += 1) {
    var suggestion = plan.suggestions[index];
    if (!selectedMap[suggestion.boxId] || remaining <= 0) {
      continue;
    }

    var allocatedFeet = Math.min(suggestion.availableFeet, remaining);
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet: allocatedFeet
    });
    remaining -= allocatedFeet;
  }

  return {
    allocations: allocations,
    remainingFeet: remaining
  };
}

function decrementBoxFeetAvailableForAllocation_(foundBoxRecord, allocatedFeet) {
  var updatedBox = cloneObject_(foundBoxRecord.box);
  updatedBox.feetAvailable = Math.max(updatedBox.feetAvailable - allocatedFeet, 0);
  updateBoxRow_(foundBoxRecord.warehouse, foundBoxRecord.rowIndex, updatedBox, false);
  foundBoxRecord.box = updatedBox;
  return updatedBox;
}

function createAllocationRecord_(foundBoxRecord, jobContext, allocatedFeet, user, filmOrderId) {
  return appendAllocation_({
    allocationId: '',
    boxId: foundBoxRecord.box.boxId,
    warehouse: foundBoxRecord.box.warehouse,
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    allocatedFeet: allocatedFeet,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString_(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    crewLeader: jobContext.crewLeader,
    filmOrderId: asTrimmedString_(filmOrderId)
  });
}

function sumFilmOrderCoveredFeet_(filmOrderId) {
  var allocations = readAllocationsByFilmOrderId_(filmOrderId);
  var total = 0;

  for (var index = 0; index < allocations.length; index += 1) {
    if (allocations[index].status !== 'CANCELLED') {
      total += allocations[index].allocatedFeet;
    }
  }

  return total;
}

function sumFilmOrderOrderedFeet_(filmOrderId) {
  var links = readFilmOrderBoxLinksByFilmOrderId_(filmOrderId);
  var total = 0;

  for (var index = 0; index < links.length; index += 1) {
    if (findRowByBoxIdAcrossWarehouses_(links[index].boxId, true)) {
      total += links[index].orderedFeet;
    }
  }

  return total;
}

function recalculateFilmOrder_(filmOrderId, user) {
  var existing = findFilmOrderById_(filmOrderId);
  if (!existing) {
    return null;
  }

  var updated = cloneObject_(existing);
  updated.coveredFeet = sumFilmOrderCoveredFeet_(filmOrderId);
  updated.orderedFeet = sumFilmOrderOrderedFeet_(filmOrderId);
  updated.remainingToOrderFeet = Math.max(updated.requestedFeet - updated.orderedFeet, 0);

  if (updated.status !== 'CANCELLED') {
    if (updated.coveredFeet >= updated.requestedFeet) {
      updated.status = 'FULFILLED';
      if (!updated.resolvedAt) {
        updated.resolvedAt = new Date().toISOString();
        updated.resolvedBy = asTrimmedString_(user);
      }
    } else if (updated.orderedFeet >= updated.requestedFeet) {
      updated.status = 'FILM_ON_THE_WAY';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    } else {
      updated.status = 'FILM_ORDER';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    }
  }

  updateFilmOrderRow_(updated.rowIndex, updated);
  return updated;
}

function createFilmOrderForShortage_(
  sourceBox,
  jobContext,
  requestedFeet,
  shortageFeet,
  user,
  shortageWarehouse
) {
  if (shortageFeet <= 0) {
    return null;
  }

  var resolvedWarehouse = asTrimmedString_(shortageWarehouse).toUpperCase();
  if (!resolvedWarehouse) {
    resolvedWarehouse = sourceBox.warehouse;
  }

  return appendFilmOrder_({
    filmOrderId: '',
    jobNumber: jobContext.jobNumber,
    warehouse: resolvedWarehouse,
    manufacturer: sourceBox.manufacturer,
    filmName: sourceBox.filmName,
    widthIn: sourceBox.widthIn,
    requestedFeet: shortageFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: shortageFeet,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    status: 'FILM_ORDER',
    sourceBoxId: sourceBox.boxId,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString_(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: 'Created from a shortage while trying to allocate ' + requestedFeet + ' LF.'
  });
}

function parseCrossWarehouseFlag_(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function normalizeOptionalWarehouse_(value, fieldName) {
  var normalized = asTrimmedString_(value).toUpperCase();
  if (!normalized) {
    return '';
  }

  if (normalized !== 'IL' && normalized !== 'MS') {
    throw new Error((fieldName || 'Warehouse') + ' must be IL or MS.');
  }

  return normalized;
}

function resolveShortageOrderWarehouse_(payload, jobContext, sourceBox) {
  var fromPayload = normalizeOptionalWarehouse_(payload && payload.jobWarehouse, 'Job warehouse');
  if (fromPayload) {
    return fromPayload;
  }

  var jobHeader = findJobByNumber_(jobContext.jobNumber);
  var fromJobHeader = normalizeOptionalWarehouse_(
    jobHeader && jobHeader.warehouse ? jobHeader.warehouse : '',
    'Job warehouse'
  );
  if (fromJobHeader) {
    return fromJobHeader;
  }

  return normalizeOptionalWarehouse_(sourceBox.warehouse, 'Warehouse') || sourceBox.warehouse;
}

function linkBoxToFilmOrder_(filmOrderId, box, user) {
  var existing = findFilmOrderById_(filmOrderId);
  if (!existing) {
    throw new Error('Film Order not found.');
  }

  if (existing.status === 'CANCELLED') {
    throw new Error('Cancelled Film Orders cannot receive new boxes.');
  }

  appendFilmOrderBoxLink_({
    linkId: '',
    filmOrderId: existing.filmOrderId,
    boxId: box.boxId,
    orderedFeet: box.initialFeet,
    autoAllocatedFeet: 0,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString_(user)
  });

  return recalculateFilmOrder_(existing.filmOrderId, user);
}

function processLinkedFilmOrderReceipt_(box, user, warnings) {
  var links = readFilmOrderBoxLinksByBoxId_(box.boxId);
  var recalculatedOrders = {};

  if (!box.receivedDate || box.status !== 'IN_STOCK' || box.feetAvailable <= 0) {
    return box;
  }

  for (var index = 0; index < links.length; index += 1) {
    var link = cloneObject_(links[index]);
    var filmOrder = findFilmOrderById_(link.filmOrderId);
    if (!filmOrder || filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    var remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
    var linkCapacity = Math.max(link.orderedFeet - link.autoAllocatedFeet, 0);
    var allocationFeet = Math.min(remainingNeed, linkCapacity, box.feetAvailable);

    if (allocationFeet <= 0) {
      continue;
    }

    createAllocationRecord_(
      {
        warehouse: box.warehouse,
        rowIndex: box.rowIndex,
        box: box
      },
      {
        jobNumber: filmOrder.jobNumber,
        jobDate: filmOrder.jobDate,
        crewLeader: filmOrder.crewLeader
      },
      allocationFeet,
      user,
      filmOrder.filmOrderId
    );
    box.feetAvailable = Math.max(box.feetAvailable - allocationFeet, 0);
    link.autoAllocatedFeet += allocationFeet;
    updateFilmOrderBoxLinkRow_(link.rowIndex, link);
    warnings.push(
      allocationFeet +
        ' LF from ' +
        box.boxId +
        ' was automatically allocated to job ' +
        filmOrder.jobNumber +
        ' for Film Order ' +
        filmOrder.filmOrderId +
        '.'
    );
    recalculatedOrders[filmOrder.filmOrderId] = true;
  }

  for (var filmOrderId in recalculatedOrders) {
    if (Object.prototype.hasOwnProperty.call(recalculatedOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, user);
    }
  }

  return box;
}

function cancelJobAndReleaseAllocations_(jobNumber, user, reason) {
  var allocations = readAllocationsByJob_(jobNumber);
  var activeByBoxId = {};
  var activeCount = 0;
  var filmOrders = readFilmOrdersByJob_(jobNumber);
  var resolvedAt = new Date().toISOString();
  var note = asTrimmedString_(reason) || 'Job cancelled.';

  for (var index = 0; index < allocations.length; index += 1) {
    var entry = cloneObject_(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + entry.allocatedFeet;
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString_(user);
    entry.notes = note;
    updateAllocationRow_(entry.rowIndex, entry);
    activeCount += 1;
  }

  for (var boxId in activeByBoxId) {
    if (!Object.prototype.hasOwnProperty.call(activeByBoxId, boxId)) {
      continue;
    }

    var found = findRowByBoxIdAcrossWarehouses_(boxId, false);
    if (!found) {
      continue;
    }

    var updatedBox = cloneObject_(found.box);
    updatedBox.feetAvailable += activeByBoxId[boxId];
    updateBoxRow_(found.warehouse, found.rowIndex, updatedBox, false);
  }

  for (index = 0; index < filmOrders.length; index += 1) {
    var order = cloneObject_(filmOrders[index]);
    if (order.status === 'CANCELLED') {
      continue;
    }

    order.status = 'CANCELLED';
    order.resolvedAt = resolvedAt;
    order.resolvedBy = asTrimmedString_(user);
    order.notes = note;
    updateFilmOrderRow_(order.rowIndex, order);
  }

  return {
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

function cancelActiveFilmOrderAllocationsForBox_(boxId, user, reason) {
  var entries = readAllocationsByBox_(boxId);
  var resolvedAt = new Date().toISOString();
  var affectedFilmOrders = {};
  var count = 0;

  for (var index = 0; index < entries.length; index += 1) {
    var entry = cloneObject_(entries[index]);
    if (entry.status !== 'ACTIVE' || !entry.filmOrderId) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString_(user);
    entry.notes = asTrimmedString_(reason) || 'Cancelled because linked box state was undone.';
    updateAllocationRow_(entry.rowIndex, entry);
    affectedFilmOrders[entry.filmOrderId] = true;
    count += 1;
  }

  for (var filmOrderId in affectedFilmOrders) {
    if (Object.prototype.hasOwnProperty.call(affectedFilmOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, user);
    }
  }

  return count;
}

function recalculateFilmOrdersForBoxLinks_(boxId, user) {
  var links = readFilmOrderBoxLinksByBoxId_(boxId);
  var seen = {};

  for (var index = 0; index < links.length; index += 1) {
    if (!seen[links[index].filmOrderId]) {
      seen[links[index].filmOrderId] = true;
      recalculateFilmOrder_(links[index].filmOrderId, user);
    }
  }
}

function buildBoxFromPayload_(payload, warnings, existingBox) {
  var boxId = existingBox ? existingBox.boxId : requireString_(payload.boxId, 'BoxID');
  var manufacturer = requireString_(payload.manufacturer, 'Manufacturer');
  var filmName = requireString_(payload.filmName, 'FilmName');
  var widthIn = coerceNonNegativeNumber_(payload.widthIn, 'WidthIn');
  var initialFeet = coerceFeetValue_(payload.initialFeet, 'InitialFeet', warnings, false);
  var orderDate = normalizeDateString_(payload.orderDate, 'OrderDate', false);
  var receivedDate = normalizeDateString_(payload.receivedDate, 'ReceivedDate', true);
  var feetAvailableInput = asTrimmedString_(payload.feetAvailable);
  var filmKey = asTrimmedString_(payload.filmKey) || buildFilmKey_(manufacturer, filmName);
  var initialWeightInput = coerceOptionalNonNegativeNumber_(payload.initialWeightLbs, 'InitialWeightLbs');
  var lastRollWeightInput = coerceOptionalNonNegativeNumber_(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  var lastWeighedDateInput = normalizeDateString_(payload.lastWeighedDate, 'LastWeighedDate', true);
  var coreTypeInput = normalizeCoreType_(payload.coreType, true);
  var existingCoreType = existingBox ? normalizeCoreType_(existingBox.coreType, true) : '';
  var feetAvailable;
  var resolvedInitialWeightLbs = initialWeightInput;
  var resolvedLastRollWeightLbs = lastRollWeightInput;
  var resolvedLastWeighedDate = lastWeighedDateInput;
  var resolvedCoreType = coreTypeInput || existingCoreType;
  var resolvedCoreWeightLbs = null;
  var resolvedLfWeightLbsPerFt = null;

  if (!feetAvailableInput) {
    if (existingBox) {
      feetAvailable = existingBox.feetAvailable;
    } else {
      feetAvailable = deriveAddFeetAvailable_(initialFeet, receivedDate);
    }
  } else {
    feetAvailable = coerceFeetValue_(payload.feetAvailable, 'FeetAvailable', warnings, true);
  }

  if (existingBox && existingBox.receivedDate && !receivedDate) {
    throw new Error('ReceivedDate cannot be cleared after a box has been received.');
  }

  if (receivedDate) {
    if (widthIn <= 0) {
      throw new Error('WidthIn must be greater than zero for received boxes.');
    }

    if (initialFeet <= 0) {
      throw new Error('InitialFeet must be greater than zero for received boxes.');
    }

    var shouldRefreshReceivingMetrics =
      !existingBox ||
      !existingBox.receivedDate ||
      existingBox.filmKey !== filmKey ||
      existingBox.widthIn !== widthIn ||
      existingBox.initialFeet !== initialFeet ||
      (coreTypeInput && coreTypeInput !== existingCoreType) ||
      initialWeightInput !== null;

    if (shouldRefreshReceivingMetrics) {
      var filmData = findFilmDataByFilmKey_(filmKey);
      var filmDataCoreType = filmData ? normalizeCoreType_(filmData.defaultCoreType, true) : '';
      var effectiveCoreType = coreTypeInput || filmDataCoreType || existingCoreType;

      if (filmData && filmData.sqFtWeightLbsPerSqFt !== null) {
        if (!effectiveCoreType) {
          throw new Error('CoreType is required before this film can be received.');
        }

        var knownSqFtWeight = coerceNonNegativeNumber_(
          filmData.sqFtWeightLbsPerSqFt,
          'SqFtWeightLbsPerSqFt'
        );
        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs_(effectiveCoreType, widthIn);
        if (initialWeightInput !== null) {
          var inputSqFtWeight = deriveSqFtWeightLbsPerSqFt_(
            initialWeightInput,
            resolvedCoreWeightLbs,
            widthIn,
            initialFeet
          );
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt_(inputSqFtWeight, widthIn);
          resolvedInitialWeightLbs = roundToDecimals_(initialWeightInput, 2);
        } else {
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt_(knownSqFtWeight, widthIn);
          resolvedInitialWeightLbs = deriveInitialWeightLbs_(
            resolvedLfWeightLbsPerFt,
            initialFeet,
            resolvedCoreWeightLbs
          );
        }

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate =
            existingBox && existingBox.lastWeighedDate ? existingBox.lastWeighedDate : receivedDate;
        }

        if ((!existingBox || !existingBox.receivedDate) && initialWeightInput === null) {
          warnings.push('Initial and last roll weights were auto-filled from FILM DATA.');
        }

        if (!filmDataCoreType || filmDataCoreType !== effectiveCoreType) {
          upsertFilmDataRecord_({
            filmKey: filmKey,
            manufacturer: filmData.manufacturer || manufacturer,
            filmName: filmData.filmName || filmName,
            sqFtWeightLbsPerSqFt: knownSqFtWeight,
            defaultCoreType: effectiveCoreType,
            sourceWidthIn: filmData.sourceWidthIn,
            sourceInitialFeet: filmData.sourceInitialFeet,
            sourceInitialWeightLbs: filmData.sourceInitialWeightLbs,
            updatedAt: new Date().toISOString(),
            sourceBoxId: filmData.sourceBoxId || boxId,
            notes: filmData.notes
          });
          warnings.push('FILM DATA was updated with the selected core type.');
        }
      } else {
        if (!effectiveCoreType) {
          throw new Error('CoreType is required the first time a received film is saved.');
        }

        var seedInitialWeight =
          initialWeightInput !== null
            ? initialWeightInput
            : existingBox && existingBox.initialWeightLbs !== null
              ? existingBox.initialWeightLbs
              : null;

        if (seedInitialWeight === null) {
          throw new Error('InitialWeightLbs is required the first time a received film is saved.');
        }

        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs_(effectiveCoreType, widthIn);
        var derivedSqFtWeight = deriveSqFtWeightLbsPerSqFt_(
          seedInitialWeight,
          resolvedCoreWeightLbs,
          widthIn,
          initialFeet
        );
        resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt_(derivedSqFtWeight, widthIn);
        resolvedInitialWeightLbs = roundToDecimals_(seedInitialWeight, 2);

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate = receivedDate;
        }

        upsertFilmDataRecord_({
          filmKey: filmKey,
          manufacturer: manufacturer,
          filmName: filmName,
          sqFtWeightLbsPerSqFt: derivedSqFtWeight,
          defaultCoreType: effectiveCoreType,
          sourceWidthIn: widthIn,
          sourceInitialFeet: initialFeet,
          sourceInitialWeightLbs: resolvedInitialWeightLbs,
          updatedAt: new Date().toISOString(),
          sourceBoxId: boxId,
          notes: ''
        });
        warnings.push('FILM DATA was created from the first received weight for ' + filmKey + '.');
      }
    } else {
      resolvedInitialWeightLbs = existingBox ? existingBox.initialWeightLbs : resolvedInitialWeightLbs;
      resolvedCoreType = coreTypeInput || existingCoreType;
      resolvedCoreWeightLbs = existingBox ? existingBox.coreWeightLbs : null;
      resolvedLfWeightLbsPerFt = existingBox ? existingBox.lfWeightLbsPerFt : null;
      resolvedLastRollWeightLbs =
        resolvedLastRollWeightLbs !== null
          ? resolvedLastRollWeightLbs
          : existingBox
            ? existingBox.lastRollWeightLbs
            : resolvedInitialWeightLbs;
      resolvedLastWeighedDate =
        resolvedLastWeighedDate || (existingBox ? existingBox.lastWeighedDate : receivedDate);
    }
  } else {
    resolvedInitialWeightLbs = null;
    resolvedLastRollWeightLbs = null;
    resolvedLastWeighedDate = '';
    resolvedCoreType = '';
    resolvedCoreWeightLbs = null;
    resolvedLfWeightLbsPerFt = null;
  }

  return {
    boxId: boxId,
    warehouse: determineWarehouseFromBoxId_(boxId),
    manufacturer: manufacturer,
    filmName: filmName,
    widthIn: widthIn,
    initialFeet: initialFeet,
    feetAvailable: feetAvailable,
    lotRun: asTrimmedString_(payload.lotRun),
    status:
      existingBox &&
      (existingBox.status === 'CHECKED_OUT' ||
        existingBox.status === 'ZEROED' ||
        existingBox.status === 'RETIRED')
        ? existingBox.status
        : deriveLifecycleStatus_(receivedDate),
    orderDate: orderDate,
    receivedDate: receivedDate,
    initialWeightLbs: resolvedInitialWeightLbs,
    lastRollWeightLbs: resolvedLastRollWeightLbs,
    lastWeighedDate: resolvedLastWeighedDate,
    filmKey: filmKey,
    coreType: resolvedCoreType,
    coreWeightLbs: resolvedCoreWeightLbs,
    lfWeightLbsPerFt: resolvedLfWeightLbsPerFt,
    purchaseCost: coerceOptionalNonNegativeNumber_(payload.purchaseCost, 'PurchaseCost'),
    notes: asTrimmedString_(payload.notes),
    hasEverBeenCheckedOut: existingBox ? existingBox.hasEverBeenCheckedOut === true : false,
    lastCheckoutJob: existingBox ? existingBox.lastCheckoutJob : '',
    lastCheckoutDate: existingBox ? existingBox.lastCheckoutDate : '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

function healthService_() {
  var sheetNames = getRequiredSheetNames_();

  for (var index = 0; index < sheetNames.length; index += 1) {
    if (sheetNames[index] === 'AuditLog') {
      getAuditSheet_();
    } else if (sheetNames[index] === 'FILM DATA') {
      getFilmDataSheet_();
    } else if (sheetNames[index] === 'ROLL WEIGHT LOG') {
      getRollWeightLogSheet_();
    } else if (sheetNames[index] === 'ALLOCATIONS') {
      getAllocationsSheet_();
    } else if (sheetNames[index] === 'FILM ORDERS') {
      getFilmOrdersSheet_();
    } else if (sheetNames[index] === 'FILM ORDER BOXES') {
      getFilmOrderBoxesSheet_();
    } else {
      getRequiredSheet_(sheetNames[index], BOX_HEADERS_);
    }
  }

  return {
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      sheets: sheetNames
    }
  };
}

function searchBoxesService_(params) {
  var warehouse = requireString_(params.warehouse, 'warehouse').toUpperCase();
  if (warehouse !== 'IL' && warehouse !== 'MS') {
    throw new Error('warehouse must be IL or MS.');
  }

  var query = asTrimmedString_(params.q).toLowerCase();
  var status = asTrimmedString_(params.status).toUpperCase();
  var film = asTrimmedString_(params.film).toLowerCase();
  var width = asTrimmedString_(params.width);
  var showRetired = String(params.showRetired) === 'true';

  var boxes = readWarehouseBoxes_(warehouse);
  if (showRetired || status === 'ZEROED') {
    boxes = boxes.concat(readSheetBoxes_(warehouse, true));
  }
  var filtered = [];

  for (var index = 0; index < boxes.length; index += 1) {
    var box = boxes[index];

    if (!showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (width && String(box.widthIn) !== width) {
      continue;
    }

    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      continue;
    }

    if (query) {
      var haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey]
        .join(' ')
        .toLowerCase();

      if (haystack.indexOf(query) === -1) {
        continue;
      }
    }

    filtered.push(toPublicBox_(cloneObject_(box)));
  }

  if (film) {
    var lowStock = [];
    var remaining = [];

    for (var filteredIndex = 0; filteredIndex < filtered.length; filteredIndex += 1) {
      if (isLowStockBox_(filtered[filteredIndex])) {
        lowStock.push(filtered[filteredIndex]);
      } else {
        remaining.push(filtered[filteredIndex]);
      }
    }

    lowStock.sort(function(a, b) {
      if (a.feetAvailable !== b.feetAvailable) {
        return a.feetAvailable - b.feetAvailable;
      }

      return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
    });

    filtered = lowStock.concat(remaining);
  }

  return { data: filtered };
}

function getBoxService_(params) {
  var found = findRowByBoxIdAcrossWarehouses_(params.boxId, true);
  if (!found) {
    throw new Error('Box not found.');
  }

  return {
    data: toPublicBox_(found.box)
  };
}

function getAllocationsByBoxService_(params) {
  var boxId = requireString_(params.boxId, 'boxId');
  var entries = readAllocationsByBox_(boxId);
  var response = [];

  for (var index = 0; index < entries.length; index += 1) {
    response.push(cloneObject_(entries[index]));
    delete response[response.length - 1].rowIndex;
  }

  return {
    data: {
      entries: response
    }
  };
}

function getAllocationPreviewService_(payload) {
  var source = findRowByBoxIdAcrossWarehouses_(payload.boxId, false);
  if (!source) {
    throw new Error('Box not found.');
  }

  if (source.box.status !== 'IN_STOCK') {
    throw new Error('Only in-stock boxes can be allocated.');
  }

  var crossWarehouse = parseCrossWarehouseFlag_(payload.crossWarehouse);
  var jobContext = resolveJobContext_(payload.jobNumber, payload.jobDate, payload.crewLeader);
  var plan = buildAllocationPreviewPlan_(source.box, payload.requestedFeet, jobContext, {
    crossWarehouse: crossWarehouse
  });

  return {
    data: plan
  };
}

function applyAllocationPlanService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var boxId = requireString_(payload.boxId, 'BoxID');
  var crossWarehouse = parseCrossWarehouseFlag_(payload.crossWarehouse);
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    var source = findRowByBoxIdAcrossWarehouses_(boxId, false);
    if (!source) {
      throw new Error('Box not found.');
    }

    if (source.box.status !== 'IN_STOCK') {
      throw new Error('Only in-stock boxes can be allocated.');
    }

    var jobContext = resolveJobContext_(payload.jobNumber, payload.jobDate, payload.crewLeader);
    var plan = buildAllocationPreviewPlan_(source.box, payload.requestedFeet, jobContext, {
      crossWarehouse: crossWarehouse
    });
    var selectedSuggestionBoxIds = [];

    if (Object.prototype.toString.call(payload.selectedSuggestionBoxIds) === '[object Array]') {
      for (var selectedIndex = 0; selectedIndex < payload.selectedSuggestionBoxIds.length; selectedIndex += 1) {
        selectedSuggestionBoxIds.push(asTrimmedString_(payload.selectedSuggestionBoxIds[selectedIndex]));
      }
    } else {
      for (var planIndex = 0; planIndex < plan.suggestions.length; planIndex += 1) {
        selectedSuggestionBoxIds.push(plan.suggestions[planIndex].boxId);
      }
    }

    var selection = calculateSelectedSuggestionAllocations_(plan, selectedSuggestionBoxIds);
    var createdAllocations = [];

    for (var index = 0; index < selection.allocations.length; index += 1) {
      var plannedAllocation = selection.allocations[index];
      if (plannedAllocation.allocatedFeet <= 0) {
        continue;
      }

      var found = findRowByBoxIdAcrossWarehouses_(plannedAllocation.boxId, false);
      if (!found || found.box.status !== 'IN_STOCK') {
        throw new Error('One of the suggested boxes is no longer available for allocation.');
      }

      if (found.box.feetAvailable < plannedAllocation.allocatedFeet) {
        throw new Error(
          found.box.boxId +
            ' no longer has enough Available Feet to cover the requested allocation.'
        );
      }

      var conflicts = getDateConflictJobsForBox_(found.box.boxId, jobContext);
      if (conflicts.length) {
        throw new Error(
          found.box.boxId +
            ' is already allocated to another job on ' +
            jobContext.jobDate +
            ' with a different crew leader.'
        );
      }

      var created = createAllocationRecord_(found, jobContext, plannedAllocation.allocatedFeet, user, '');
      decrementBoxFeetAvailableForAllocation_(found, plannedAllocation.allocatedFeet);
      var publicEntry = cloneObject_(created);
      delete publicEntry.rowIndex;
      createdAllocations.push(publicEntry);
    }

    var filmOrder = null;
    if (selection.remainingFeet > 0) {
      var shortageOrderWarehouse = resolveShortageOrderWarehouse_(payload, jobContext, source.box);
      filmOrder = createFilmOrderForShortage_(
        source.box,
        jobContext,
        plan.requestedFeet,
        selection.remainingFeet,
        user,
        shortageOrderWarehouse
      );
      warnings.push(
        'A Film Order alert was created for the remaining ' +
          selection.remainingFeet +
          ' LF needed for job ' +
          jobContext.jobNumber +
          '.'
      );
    }

    if (createdAllocations.length > 0) {
      warnings.push(
        createdAllocations.length +
          ' allocation' +
          (createdAllocations.length === 1 ? ' was' : 's were') +
          ' created for job ' +
          jobContext.jobNumber +
          '.'
      );
    }

    return {
      data: {
        allocations: createdAllocations,
        filmOrder: filmOrder ? cloneObject_(filmOrder) : null,
        remainingUncoveredFeet: selection.remainingFeet
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function allocateBoxService_(payload) {
  return applyAllocationPlanService_(payload);
}

function buildPublicFilmOrderLinkedBoxes_(filmOrderId) {
  var links = readFilmOrderBoxLinksByFilmOrderId_(filmOrderId);
  var response = [];

  for (var index = 0; index < links.length; index += 1) {
    var link = links[index];
    if (!link.boxId) {
      continue;
    }

    if (!findRowByBoxIdAcrossWarehouses_(link.boxId, false) && !findZeroedRowByBoxIdAcrossWarehouses_(link.boxId)) {
      continue;
    }

    response.push({
      boxId: link.boxId,
      orderedFeet: link.orderedFeet,
      autoAllocatedFeet: link.autoAllocatedFeet
    });
  }

  response.sort(function(a, b) {
    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  return response;
}

function resolveAllocationJobMetadata_(allocations, filmOrders) {
  var jobDate = '';
  var crewLeader = '';

  for (var index = 0; index < allocations.length; index += 1) {
    if (!jobDate && allocations[index].jobDate) {
      jobDate = allocations[index].jobDate;
    }

    if (!crewLeader && allocations[index].crewLeader) {
      crewLeader = allocations[index].crewLeader;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < filmOrders.length; filmOrderIndex += 1) {
    if (!jobDate && filmOrders[filmOrderIndex].jobDate) {
      jobDate = filmOrders[filmOrderIndex].jobDate;
    }

    if (!crewLeader && filmOrders[filmOrderIndex].crewLeader) {
      crewLeader = filmOrders[filmOrderIndex].crewLeader;
    }
  }

  return {
    jobDate: jobDate,
    crewLeader: crewLeader
  };
}

function buildAllocationJobSummary_(jobNumber, allocations, filmOrders) {
  var metadata = resolveAllocationJobMetadata_(allocations, filmOrders);
  var hasFilmOrder = false;
  var hasFilmOnTheWay = false;
  var hasActiveAllocation = false;
  var hasCancelledRecord = false;
  var hasFulfilledRecord = false;
  var activeAllocatedFeet = 0;
  var fulfilledAllocatedFeet = 0;
  var openFilmOrderCount = 0;
  var distinctBoxes = {};

  for (var allocationIndex = 0; allocationIndex < allocations.length; allocationIndex += 1) {
    var allocation = allocations[allocationIndex];
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }

    if (allocation.status === 'ACTIVE') {
      hasActiveAllocation = true;
      activeAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'FULFILLED') {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < filmOrders.length; filmOrderIndex += 1) {
    var filmOrder = filmOrders[filmOrderIndex];

    if (filmOrder.status === 'FILM_ORDER') {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FILM_ON_THE_WAY') {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FULFILLED') {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  var status = 'READY';
  if (hasFilmOrder) {
    status = 'FILM_ORDER';
  } else if (hasFilmOnTheWay) {
    status = 'ON_ORDER';
  } else if (hasActiveAllocation) {
    status = 'READY';
  } else if (hasCancelledRecord) {
    status = 'CANCELLED';
  } else if (hasFulfilledRecord) {
    status = 'COMPLETED';
  }

  return {
    jobNumber: jobNumber,
    jobDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    status: status,
    activeAllocatedFeet: activeAllocatedFeet,
    fulfilledAllocatedFeet: fulfilledAllocatedFeet,
    openFilmOrderCount: openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length
  };
}

function compareAllocationJobSummaries_(a, b) {
  if (a.jobDate && b.jobDate && a.jobDate !== b.jobDate) {
    return a.jobDate < b.jobDate ? -1 : 1;
  }

  if (a.jobDate && !b.jobDate) {
    return -1;
  }

  if (!a.jobDate && b.jobDate) {
    return 1;
  }

  return a.jobNumber < b.jobNumber ? -1 : a.jobNumber > b.jobNumber ? 1 : 0;
}

function buildPublicAllocationJobEntry_(entry) {
  var publicEntry = cloneObject_(entry);
  delete publicEntry.rowIndex;
  publicEntry.manufacturer = '';
  publicEntry.filmName = '';
  publicEntry.widthIn = 0;
  publicEntry.boxStatus = '';

  var boxRecord = findRowByBoxIdAcrossWarehouses_(entry.boxId, true);
  if (boxRecord && boxRecord.box) {
    publicEntry.manufacturer = boxRecord.box.manufacturer;
    publicEntry.filmName = boxRecord.box.filmName;
    publicEntry.widthIn = boxRecord.box.widthIn;
    publicEntry.boxStatus = boxRecord.box.status;
  }

  return publicEntry;
}

function groupEntriesByJobNumber_(entries) {
  var grouped = {};

  for (var index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    if (!entry.jobNumber) {
      continue;
    }

    if (!grouped[entry.jobNumber]) {
      grouped[entry.jobNumber] = [];
    }

    grouped[entry.jobNumber].push(entry);
  }

  return grouped;
}

function getAllocationJobsService_() {
  var allAllocations = readAllocations_();
  var allFilmOrders = readFilmOrders_();
  var groupedAllocations = groupEntriesByJobNumber_(allAllocations);
  var groupedFilmOrders = groupEntriesByJobNumber_(allFilmOrders);
  var jobNumbers = {};
  var response = [];

  for (var allocationIndex = 0; allocationIndex < allAllocations.length; allocationIndex += 1) {
    if (allAllocations[allocationIndex].jobNumber) {
      jobNumbers[allAllocations[allocationIndex].jobNumber] = true;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < allFilmOrders.length; filmOrderIndex += 1) {
    if (allFilmOrders[filmOrderIndex].jobNumber) {
      jobNumbers[allFilmOrders[filmOrderIndex].jobNumber] = true;
    }
  }

  var keys = Object.keys(jobNumbers);
  for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    var jobNumber = keys[keyIndex];
    response.push(
      buildAllocationJobSummary_(
        jobNumber,
        groupedAllocations[jobNumber] || [],
        groupedFilmOrders[jobNumber] || []
      )
    );
  }

  response.sort(compareAllocationJobSummaries_);

  return {
    data: {
      entries: response
    }
  };
}

function getAllocationByJobService_(params) {
  var jobNumber = requireString_(params.jobNumber, 'jobNumber');
  var allocations = readAllocationsByJob_(jobNumber);
  var filmOrders = readFilmOrdersByJob_(jobNumber);
  var publicAllocations = [];
  var publicFilmOrders = [];

  if (!allocations.length && !filmOrders.length) {
    throw new Error('Job not found.');
  }

  allocations.sort(function(a, b) {
    if (a.status !== b.status) {
      return a.status === 'ACTIVE' ? -1 : b.status === 'ACTIVE' ? 1 : a.status < b.status ? -1 : 1;
    }

    if (a.jobDate !== b.jobDate) {
      if (a.jobDate && b.jobDate) {
        return a.jobDate < b.jobDate ? -1 : 1;
      }

      if (a.jobDate) {
        return -1;
      }

      if (b.jobDate) {
        return 1;
      }
    }

    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  for (var allocationIndex = 0; allocationIndex < allocations.length; allocationIndex += 1) {
    publicAllocations.push(buildPublicAllocationJobEntry_(allocations[allocationIndex]));
  }

  filmOrders.sort(function(a, b) {
    return compareAllocationJobSummaries_(
      { jobDate: a.createdAt, jobNumber: a.filmOrderId },
      { jobDate: b.createdAt, jobNumber: b.filmOrderId }
    );
  });

  for (var filmOrderIndex = 0; filmOrderIndex < filmOrders.length; filmOrderIndex += 1) {
    var publicFilmOrder = cloneObject_(filmOrders[filmOrderIndex]);
    delete publicFilmOrder.rowIndex;
    publicFilmOrder.linkedBoxes = buildPublicFilmOrderLinkedBoxes_(publicFilmOrder.filmOrderId);
    publicFilmOrders.push(publicFilmOrder);
  }

  return {
    data: {
      summary: buildAllocationJobSummary_(jobNumber, allocations, filmOrders),
      allocations: publicAllocations,
      filmOrders: publicFilmOrders
    }
  };
}

function getFilmOrdersService_() {
  var entries = readFilmOrders_();
  var response = [];

  entries.sort(function(a, b) {
    var aOpen = a.status === 'FILM_ORDER' || a.status === 'FILM_ON_THE_WAY';
    var bOpen = b.status === 'FILM_ORDER' || b.status === 'FILM_ON_THE_WAY';

    if (aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }

    if (aOpen) {
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }

    var aResolved = a.resolvedAt || a.createdAt;
    var bResolved = b.resolvedAt || b.createdAt;
    return aResolved < bResolved ? -1 : aResolved > bResolved ? 1 : 0;
  });

  for (var index = 0; index < entries.length; index += 1) {
    var publicEntry = cloneObject_(entries[index]);
    delete publicEntry.rowIndex;
    publicEntry.linkedBoxes = buildPublicFilmOrderLinkedBoxes_(publicEntry.filmOrderId);
    response.push(publicEntry);
  }

  return {
    data: {
      entries: response
    }
  };
}

function normalizeJobNumberDigits_(value, fieldName) {
  var normalized = requireString_(value, fieldName || 'JobNumber');
  if (!/^\d+$/.test(normalized)) {
    throw new Error((fieldName || 'JobNumber') + ' must contain numbers only.');
  }

  return normalized;
}

function normalizeJobWarehouse_(value) {
  var normalized = requireString_(value, 'Warehouse').toUpperCase();
  if (normalized !== 'IL' && normalized !== 'MS') {
    throw new Error('Warehouse must be IL or MS.');
  }

  return normalized;
}

function normalizeJobSections_(value) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    return null;
  }

  var rawParts = trimmed.split(',');
  var normalizedParts = [];
  for (var index = 0; index < rawParts.length; index += 1) {
    var token = asTrimmedString_(rawParts[index]);
    if (!token) {
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new Error('Sections must contain numbers separated by commas.');
    }

    normalizedParts.push(token);
  }

  if (!normalizedParts.length) {
    return null;
  }

  return normalizedParts.join(', ');
}

function normalizeJobLifecycleStatus_(value) {
  var normalized = asTrimmedString_(value).toUpperCase();
  if (normalized === 'CANCELLED') {
    return 'CANCELLED';
  }

  return 'ACTIVE';
}

function normalizeRequirementWidthKey_(value) {
  return String(roundToDecimals_(Number(value), 4));
}

function normalizeJobRequirementLookupKey_(manufacturer, filmName, widthIn) {
  return (
    normalizeCatalogLookupKey_(manufacturer) +
    '|' +
    normalizeCatalogLookupKey_(filmName) +
    '|' +
    normalizeRequirementWidthKey_(widthIn)
  );
}

function normalizeJobRequirementInput_(entry, warnings, index) {
  var prefix = 'Requirements[' + index + ']';
  var manufacturer = requireString_(entry && entry.manufacturer, prefix + '.Manufacturer');
  var filmName = requireString_(entry && entry.filmName, prefix + '.FilmName');
  var widthIn = coerceNonNegativeNumber_(entry && entry.widthIn, prefix + '.WidthIn');
  var requiredFeet = coerceFeetValue_(entry && entry.requiredFeet, prefix + '.RequiredFeet', warnings, false);

  if (widthIn <= 0) {
    throw new Error(prefix + '.WidthIn must be greater than zero.');
  }

  if (requiredFeet <= 0) {
    throw new Error(prefix + '.RequiredFeet must be greater than zero.');
  }

  return {
    manufacturer: normalizeCollapsedCatalogLabel_(manufacturer),
    filmName: normalizeCollapsedCatalogLabel_(filmName),
    widthIn: widthIn,
    requiredFeet: requiredFeet
  };
}

function dedupeJobRequirements_(requirements, warnings) {
  var deduped = {};
  var index;
  var normalizedEntry;
  var key;

  if (!requirements || !Array.isArray(requirements)) {
    return [];
  }

  for (index = 0; index < requirements.length; index += 1) {
    normalizedEntry = normalizeJobRequirementInput_(requirements[index], warnings, index);
    key = normalizeJobRequirementLookupKey_(
      normalizedEntry.manufacturer,
      normalizedEntry.filmName,
      normalizedEntry.widthIn
    );

    if (!deduped[key]) {
      deduped[key] = normalizedEntry;
      continue;
    }

    deduped[key].requiredFeet += normalizedEntry.requiredFeet;
  }

  var values = [];
  for (var dedupeKey in deduped) {
    if (Object.prototype.hasOwnProperty.call(deduped, dedupeKey)) {
      values.push(deduped[dedupeKey]);
    }
  }

  values.sort(function(a, b) {
    var manufacturerCompare = compareCatalogStrings_(a.manufacturer, b.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    var filmCompare = compareCatalogStrings_(a.filmName, b.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (a.widthIn !== b.widthIn) {
      return a.widthIn < b.widthIn ? -1 : 1;
    }

    return 0;
  });

  return values;
}

function buildJobRequirementsByLookupKey_(entries) {
  var byKey = {};

  for (var index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    byKey[
      normalizeJobRequirementLookupKey_(entry.manufacturer, entry.filmName, entry.widthIn)
    ] = entry;
  }

  return byKey;
}

function buildAllocationCoverageByRequirementKey_(allocations) {
  var totals = {};

  for (var index = 0; index < allocations.length; index += 1) {
    var allocation = allocations[index];
    if (allocation.status === 'CANCELLED') {
      continue;
    }

    var allocatedFeet = Number(allocation.allocatedFeet || 0);
    if (allocatedFeet <= 0) {
      continue;
    }

    var boxRecord = findRowByBoxIdAcrossWarehouses_(allocation.boxId, true);
    if (!boxRecord || !boxRecord.box) {
      continue;
    }

    var key = normalizeJobRequirementLookupKey_(
      boxRecord.box.manufacturer,
      boxRecord.box.filmName,
      boxRecord.box.widthIn
    );
    totals[key] = (totals[key] || 0) + allocatedFeet;
  }

  return totals;
}

function buildPublicJobRequirementEntries_(requirements, allocations) {
  var coverage = buildAllocationCoverageByRequirementKey_(allocations);
  var response = [];

  for (var index = 0; index < requirements.length; index += 1) {
    var requirement = requirements[index];
    var key = normalizeJobRequirementLookupKey_(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    );
    var allocatedFeet = Math.max(0, Number(coverage[key] || 0));
    var requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    var remainingFeet = Math.max(0, requiredFeet - allocatedFeet);
    var cappedAllocatedFeet = requiredFeet - remainingFeet;

    response.push({
      requirementId: requirement.requirementId,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet: requiredFeet,
      allocatedFeet: cappedAllocatedFeet,
      remainingFeet: remainingFeet
    });
  }

  response.sort(function(a, b) {
    var manufacturerCompare = compareCatalogStrings_(a.manufacturer, b.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    var filmCompare = compareCatalogStrings_(a.filmName, b.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (a.widthIn !== b.widthIn) {
      return a.widthIn < b.widthIn ? -1 : 1;
    }

    return compareCatalogStrings_(a.requirementId, b.requirementId);
  });

  return response;
}

function buildLegacyJobHeaderFromData_(jobNumber, allocations, filmOrders) {
  var metadata = resolveAllocationJobMetadata_(allocations, filmOrders);
  var warehouse = '';
  var createdAt = '';
  var updatedAt = '';
  var index;

  for (index = 0; index < allocations.length; index += 1) {
    if (!warehouse && allocations[index].warehouse) {
      warehouse = allocations[index].warehouse;
    }

    if (!createdAt || (allocations[index].createdAt && allocations[index].createdAt < createdAt)) {
      createdAt = allocations[index].createdAt || createdAt;
    }

    if (!updatedAt || (allocations[index].createdAt && allocations[index].createdAt > updatedAt)) {
      updatedAt = allocations[index].createdAt || updatedAt;
    }
  }

  for (index = 0; index < filmOrders.length; index += 1) {
    if (!warehouse && filmOrders[index].warehouse) {
      warehouse = filmOrders[index].warehouse;
    }

    if (!createdAt || (filmOrders[index].createdAt && filmOrders[index].createdAt < createdAt)) {
      createdAt = filmOrders[index].createdAt || createdAt;
    }

    var filmUpdatedAt = filmOrders[index].resolvedAt || filmOrders[index].createdAt;
    if (!updatedAt || (filmUpdatedAt && filmUpdatedAt > updatedAt)) {
      updatedAt = filmUpdatedAt || updatedAt;
    }
  }

  return {
    jobNumber: jobNumber,
    warehouse: warehouse || 'IL',
    sections: null,
    dueDate: metadata.jobDate,
    lifecycleStatus: 'ACTIVE',
    createdAt: createdAt,
    createdBy: '',
    updatedAt: updatedAt,
    updatedBy: '',
    notes: '',
    rowIndex: 0
  };
}

function deriveJobStatusFromLegacyAllocationData_(allocations, filmOrders) {
  var legacySummary = buildAllocationJobSummary_('', allocations || [], filmOrders || []);
  if (legacySummary.status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (legacySummary.status === 'READY' || legacySummary.status === 'COMPLETED') {
    return 'READY';
  }

  return 'ALLOCATE';
}

function computeJobStatusFromRequirements_(lifecycleStatus, requirements, allocations, filmOrders) {
  if (normalizeJobLifecycleStatus_(lifecycleStatus) === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (!requirements.length) {
    if (!allocations.length && !filmOrders.length) {
      return 'ALLOCATE';
    }

    return deriveJobStatusFromLegacyAllocationData_(allocations, filmOrders);
  }

  for (var index = 0; index < requirements.length; index += 1) {
    if (requirements[index].remainingFeet > 0) {
      return 'ALLOCATE';
    }
  }

  return 'READY';
}

function buildJobListEntry_(jobHeader, requirements, allocations, filmOrders) {
  var dueDate = jobHeader.dueDate;
  if (!dueDate) {
    dueDate = resolveAllocationJobMetadata_(allocations, filmOrders).jobDate;
  }

  var requiredFeet = 0;
  var allocatedFeet = 0;
  var remainingFeet = 0;

  for (var index = 0; index < requirements.length; index += 1) {
    requiredFeet += requirements[index].requiredFeet;
    allocatedFeet += requirements[index].allocatedFeet;
    remainingFeet += requirements[index].remainingFeet;
  }

  return {
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || 'IL',
    sections: jobHeader.sections,
    dueDate: dueDate,
    status: computeJobStatusFromRequirements_(
      jobHeader.lifecycleStatus,
      requirements,
      allocations,
      filmOrders
    ),
    lifecycleStatus: normalizeJobLifecycleStatus_(jobHeader.lifecycleStatus),
    requiredFeet: requiredFeet,
    allocatedFeet: allocatedFeet,
    remainingFeet: remainingFeet,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: filmOrders.length,
    updatedAt: jobHeader.updatedAt || '',
    notes: jobHeader.notes || ''
  };
}

function compareJobsListEntries_(a, b) {
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
    return a.dueDate > b.dueDate ? -1 : 1;
  }

  if (a.dueDate && !b.dueDate) {
    return -1;
  }

  if (!a.dueDate && b.dueDate) {
    return 1;
  }

  if (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? -1 : 1;
  }

  if (a.updatedAt && !b.updatedAt) {
    return -1;
  }

  if (!a.updatedAt && b.updatedAt) {
    return 1;
  }

  return a.jobNumber > b.jobNumber ? -1 : a.jobNumber < b.jobNumber ? 1 : 0;
}

function buildJobsListEntries_(limit) {
  var jobs = readJobs_();
  var allAllocations = readAllocations_();
  var allFilmOrders = readFilmOrders_();
  var allRequirements = readJobRequirements_();
  var groupedAllocations = groupEntriesByJobNumber_(allAllocations);
  var groupedFilmOrders = groupEntriesByJobNumber_(allFilmOrders);
  var groupedRequirements = groupEntriesByJobNumber_(allRequirements);
  var byJobNumber = {};
  var response = [];

  for (var jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    byJobNumber[jobs[jobIndex].jobNumber] = jobs[jobIndex];
  }

  for (var allocationIndex = 0; allocationIndex < allAllocations.length; allocationIndex += 1) {
    if (allAllocations[allocationIndex].jobNumber) {
      byJobNumber[allAllocations[allocationIndex].jobNumber] =
        byJobNumber[allAllocations[allocationIndex].jobNumber] || null;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < allFilmOrders.length; filmOrderIndex += 1) {
    if (allFilmOrders[filmOrderIndex].jobNumber) {
      byJobNumber[allFilmOrders[filmOrderIndex].jobNumber] =
        byJobNumber[allFilmOrders[filmOrderIndex].jobNumber] || null;
    }
  }

  var jobNumbers = Object.keys(byJobNumber);
  for (var index = 0; index < jobNumbers.length; index += 1) {
    var jobNumber = jobNumbers[index];
    var allocations = groupedAllocations[jobNumber] || [];
    var filmOrders = groupedFilmOrders[jobNumber] || [];
    var requirements = buildPublicJobRequirementEntries_(groupedRequirements[jobNumber] || [], allocations);
    var header = byJobNumber[jobNumber] || buildLegacyJobHeaderFromData_(jobNumber, allocations, filmOrders);

    response.push(buildJobListEntry_(header, requirements, allocations, filmOrders));
  }

  response.sort(compareJobsListEntries_);

  if (limit > 0 && response.length > limit) {
    return response.slice(0, limit);
  }

  return response;
}

function getJobsListService_(params) {
  var limitValue = Number(params && params.limit);
  var limit = 25;
  if (isFinite(limitValue) && limitValue > 0) {
    limit = Math.floor(limitValue);
  }

  return {
    data: {
      entries: buildJobsListEntries_(limit)
    }
  };
}

function buildPublicAllocationEntriesForJob_(allocations) {
  var response = [];

  allocations.sort(function(a, b) {
    if (a.status !== b.status) {
      return a.status === 'ACTIVE' ? -1 : b.status === 'ACTIVE' ? 1 : a.status < b.status ? -1 : 1;
    }

    if (a.jobDate !== b.jobDate) {
      if (a.jobDate && b.jobDate) {
        return a.jobDate < b.jobDate ? -1 : 1;
      }

      if (a.jobDate) {
        return -1;
      }

      if (b.jobDate) {
        return 1;
      }
    }

    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  for (var index = 0; index < allocations.length; index += 1) {
    response.push(buildPublicAllocationJobEntry_(allocations[index]));
  }

  return response;
}

function buildPublicFilmOrdersForJob_(filmOrders) {
  var response = [];

  filmOrders.sort(function(a, b) {
    return compareAllocationJobSummaries_(
      { jobDate: a.createdAt, jobNumber: a.filmOrderId },
      { jobDate: b.createdAt, jobNumber: b.filmOrderId }
    );
  });

  for (var index = 0; index < filmOrders.length; index += 1) {
    var publicFilmOrder = cloneObject_(filmOrders[index]);
    delete publicFilmOrder.rowIndex;
    publicFilmOrder.linkedBoxes = buildPublicFilmOrderLinkedBoxes_(publicFilmOrder.filmOrderId);
    response.push(publicFilmOrder);
  }

  return response;
}

function getJobService_(params) {
  var jobNumber = requireString_(params && params.jobNumber, 'jobNumber');
  var header = findJobByNumber_(jobNumber);
  var allocations = readAllocationsByJob_(jobNumber);
  var filmOrders = readFilmOrdersByJob_(jobNumber);
  var requirements = readJobRequirementsByJob_(jobNumber);

  if (!header && !allocations.length && !filmOrders.length && !requirements.length) {
    throw new Error('Job not found.');
  }

  if (!header) {
    header = buildLegacyJobHeaderFromData_(jobNumber, allocations, filmOrders);
  }

  var publicRequirements = buildPublicJobRequirementEntries_(requirements, allocations);
  var summary = buildJobListEntry_(header, publicRequirements, allocations, filmOrders);

  return {
    data: {
      summary: summary,
      requirements: publicRequirements,
      allocations: buildPublicAllocationEntriesForJob_(allocations),
      filmOrders: buildPublicFilmOrdersForJob_(filmOrders)
    }
  };
}

function buildRequirementRowsForReplace_(
  jobNumber,
  requirementEntries,
  existingByKey,
  user,
  nowIso
) {
  var rows = [];

  for (var index = 0; index < requirementEntries.length; index += 1) {
    var requirement = requirementEntries[index];
    var key = normalizeJobRequirementLookupKey_(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    );
    var existing = existingByKey[key] || null;

    rows.push({
      requirementId: existing ? existing.requirementId : '',
      jobNumber: jobNumber,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet: requirement.requiredFeet,
      createdAt: existing ? existing.createdAt : nowIso,
      createdBy: existing ? existing.createdBy : user,
      updatedAt: nowIso,
      updatedBy: user,
      notes: existing ? existing.notes : ''
    });
  }

  return rows;
}

function ensureJobHeaderForUpdate_(jobNumber, payload, user, nowIso) {
  var existing = findJobByNumber_(jobNumber);
  if (existing) {
    return existing;
  }

  var legacyAllocations = readAllocationsByJob_(jobNumber);
  var legacyFilmOrders = readFilmOrdersByJob_(jobNumber);
  var derived = buildLegacyJobHeaderFromData_(jobNumber, legacyAllocations, legacyFilmOrders);

  derived.warehouse = payload.warehouse ? normalizeJobWarehouse_(payload.warehouse) : derived.warehouse;
  derived.sections = normalizeJobSections_(payload.sections);
  derived.dueDate = normalizeDateString_(payload.dueDate, 'DueDate', true);
  derived.lifecycleStatus = normalizeJobLifecycleStatus_(payload.lifecycleStatus);
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || user;
  derived.updatedAt = nowIso;
  derived.updatedBy = user;
  derived.notes = asTrimmedString_(payload.notes || derived.notes);

  return appendJob_(derived);
}

function createJobService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var jobNumber = normalizeJobNumberDigits_(payload.jobNumber, 'Job ID number');
  var warehouse = normalizeJobWarehouse_(payload.warehouse);
  var sections = normalizeJobSections_(payload.sections);
  var dueDate = normalizeDateString_(payload.dueDate, 'DueDate', true);
  var lifecycleStatus = normalizeJobLifecycleStatus_(payload.lifecycleStatus);
  var notes = asTrimmedString_(payload.notes);
  var incomingRequirements = dedupeJobRequirements_(payload.requirements, warnings);
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    var nowIso = new Date().toISOString();
    var existingHeader = findJobByNumber_(jobNumber);
    var nextHeader = existingHeader
      ? cloneObject_(existingHeader)
      : {
          jobNumber: jobNumber,
          warehouse: warehouse,
          sections: sections,
          dueDate: dueDate,
          lifecycleStatus: lifecycleStatus,
          createdAt: nowIso,
          createdBy: user,
          updatedAt: nowIso,
          updatedBy: user,
          notes: notes
        };

    if (existingHeader) {
      nextHeader.warehouse = warehouse;
      nextHeader.sections = sections;
      nextHeader.dueDate = dueDate;
      nextHeader.lifecycleStatus = lifecycleStatus;
      nextHeader.updatedAt = nowIso;
      nextHeader.updatedBy = user;
      nextHeader.notes = notes;
      updateJobRow_(existingHeader.rowIndex, nextHeader);
    } else {
      nextHeader = appendJob_(nextHeader);
    }

    var existingRequirements = readJobRequirementsByJob_(jobNumber);
    var merged = {};
    var index;

    for (index = 0; index < existingRequirements.length; index += 1) {
      var existing = existingRequirements[index];
      var existingKey = normalizeJobRequirementLookupKey_(
        existing.manufacturer,
        existing.filmName,
        existing.widthIn
      );
      merged[existingKey] = {
        manufacturer: existing.manufacturer,
        filmName: existing.filmName,
        widthIn: existing.widthIn,
        requiredFeet: existing.requiredFeet
      };
    }

    for (index = 0; index < incomingRequirements.length; index += 1) {
      var incoming = incomingRequirements[index];
      var incomingKey = normalizeJobRequirementLookupKey_(
        incoming.manufacturer,
        incoming.filmName,
        incoming.widthIn
      );
      if (!merged[incomingKey]) {
        merged[incomingKey] = incoming;
        continue;
      }

      merged[incomingKey].requiredFeet += incoming.requiredFeet;
    }

    var mergedValues = [];
    for (var mergedKey in merged) {
      if (Object.prototype.hasOwnProperty.call(merged, mergedKey)) {
        mergedValues.push(merged[mergedKey]);
      }
    }

    var existingByKey = buildJobRequirementsByLookupKey_(existingRequirements);
    replaceJobRequirementsForJob_(
      jobNumber,
      buildRequirementRowsForReplace_(jobNumber, mergedValues, existingByKey, user, nowIso)
    );

    var result = getJobService_({ jobNumber: jobNumber });
    return {
      data: result.data,
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function updateJobService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var jobNumber = normalizeJobNumberDigits_(payload.jobNumber, 'Job ID number');
  var requirements = dedupeJobRequirements_(payload.requirements, warnings);
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    var nowIso = new Date().toISOString();
    var header = ensureJobHeaderForUpdate_(jobNumber, payload, user, nowIso);
    var nextHeader = cloneObject_(header);

    if (payload.warehouse !== undefined) {
      nextHeader.warehouse = normalizeJobWarehouse_(payload.warehouse);
    }

    if (payload.sections !== undefined) {
      nextHeader.sections = normalizeJobSections_(payload.sections);
    }

    if (payload.dueDate !== undefined) {
      nextHeader.dueDate = normalizeDateString_(payload.dueDate, 'DueDate', true);
    }

    if (payload.lifecycleStatus !== undefined) {
      nextHeader.lifecycleStatus = normalizeJobLifecycleStatus_(payload.lifecycleStatus);
    }

    if (payload.notes !== undefined) {
      nextHeader.notes = asTrimmedString_(payload.notes);
    }

    nextHeader.updatedAt = nowIso;
    nextHeader.updatedBy = user;

    updateJobRow_(header.rowIndex, nextHeader);

    var existingRequirements = readJobRequirementsByJob_(jobNumber);
    var existingByKey = buildJobRequirementsByLookupKey_(existingRequirements);
    replaceJobRequirementsForJob_(
      jobNumber,
      buildRequirementRowsForReplace_(jobNumber, requirements, existingByKey, user, nowIso)
    );

    var result = getJobService_({ jobNumber: jobNumber });
    return {
      data: result.data,
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function normalizeCollapsedCatalogLabel_(value) {
  return asTrimmedString_(value).replace(/\s+/g, ' ');
}

function normalizeCatalogLookupKey_(value) {
  return normalizeCollapsedCatalogLabel_(value).toLowerCase();
}

function compareCatalogStrings_(left, right) {
  var leftValue = asTrimmedString_(left).toLowerCase();
  var rightValue = asTrimmedString_(right).toLowerCase();

  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

function getFilmCatalogService_(_params) {
  var entries = readFilmData_();
  var dedupedByKey = {};
  var response = [];
  var index;

  for (index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    var manufacturer = normalizeCollapsedCatalogLabel_(entry.manufacturer);
    var filmName = normalizeCollapsedCatalogLabel_(entry.filmName);
    var manufacturerKey = normalizeCatalogLookupKey_(manufacturer);
    var filmNameKey = normalizeCatalogLookupKey_(filmName);

    if (!manufacturerKey || !filmNameKey) {
      continue;
    }

    dedupedByKey[manufacturerKey + '|' + filmNameKey] = {
      filmKey: asTrimmedString_(entry.filmKey).toUpperCase(),
      manufacturer: manufacturer,
      filmName: filmName,
      updatedAt: asTrimmedString_(entry.updatedAt)
    };
  }

  for (var dedupeKey in dedupedByKey) {
    if (Object.prototype.hasOwnProperty.call(dedupedByKey, dedupeKey)) {
      response.push(dedupedByKey[dedupeKey]);
    }
  }

  response.sort(function(a, b) {
    var manufacturerCompare = compareCatalogStrings_(a.manufacturer, b.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    var filmCompare = compareCatalogStrings_(a.filmName, b.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    return compareCatalogStrings_(a.filmKey, b.filmKey);
  });

  return {
    data: {
      entries: response
    }
  };
}

function createFilmOrderService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var warehouse = requireString_(payload.warehouse, 'Warehouse').toUpperCase();
  var jobNumber = requireString_(payload.jobNumber, 'JobNumber');
  var manufacturer = requireString_(payload.manufacturer, 'Manufacturer');
  var filmName = requireString_(payload.filmName, 'FilmName');
  var widthIn = coerceNonNegativeNumber_(payload.widthIn, 'WidthIn');
  var requestedFeet = coerceFeetValue_(payload.requestedFeet, 'RequestedFeet', warnings, false);
  var lock = LockService.getScriptLock();
  var entry;
  var publicEntry;

  if (warehouse !== 'IL' && warehouse !== 'MS') {
    throw new Error('Warehouse must be IL or MS.');
  }

  if (widthIn <= 0) {
    throw new Error('WidthIn must be greater than zero.');
  }

  if (requestedFeet <= 0) {
    throw new Error('RequestedFeet must be greater than zero.');
  }

  lock.waitLock(30000);

  try {
    entry = appendFilmOrder_({
      filmOrderId: '',
      jobNumber: jobNumber,
      warehouse: warehouse,
      manufacturer: manufacturer,
      filmName: filmName,
      widthIn: widthIn,
      requestedFeet: requestedFeet,
      coveredFeet: 0,
      orderedFeet: 0,
      remainingToOrderFeet: requestedFeet,
      jobDate: '',
      crewLeader: '',
      status: 'FILM_ORDER',
      sourceBoxId: '',
      createdAt: new Date().toISOString(),
      createdBy: asTrimmedString_(user),
      resolvedAt: '',
      resolvedBy: '',
      notes: 'Created manually from Film Orders.'
    });

    publicEntry = cloneObject_(entry);
    delete publicEntry.rowIndex;
    publicEntry.linkedBoxes = [];

    return {
      data: publicEntry,
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function cancelJobService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var jobNumber = requireString_(payload.jobNumber, 'JobNumber');
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    var result = cancelJobAndReleaseAllocations_(jobNumber, user, payload.reason);
    var existingJob = findJobByNumber_(jobNumber);
    if (existingJob) {
      existingJob.lifecycleStatus = 'CANCELLED';
      existingJob.updatedAt = new Date().toISOString();
      existingJob.updatedBy = user;
      updateJobRow_(existingJob.rowIndex, existingJob);
    }

    warnings.push(
      'Cancelled job ' +
        jobNumber +
        '. Released ' +
        result.releasedAllocationCount +
        ' active allocation' +
        (result.releasedAllocationCount === 1 ? '' : 's') +
        ' across ' +
        result.affectedBoxCount +
        ' box' +
        (result.affectedBoxCount === 1 ? '' : 'es') +
        '.'
    );

    return {
      data: {
        jobNumber: jobNumber
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function getRollHistoryByBoxService_(params) {
  var boxId = requireString_(params.boxId, 'boxId');
  var entries = readRollWeightLogByBox_(boxId);
  var response = [];

  for (var index = 0; index < entries.length; index += 1) {
    response.push(cloneObject_(entries[index]));
    delete response[response.length - 1].rowIndex;
  }

  return {
    data: {
      entries: response
    }
  };
}

function boxMatchesReportFilters_(box, filters) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }

  if (
    filters.manufacturer &&
    box.manufacturer.toLowerCase().indexOf(filters.manufacturer.toLowerCase()) === -1
  ) {
    return false;
  }

  if (
    filters.film &&
    box.filmName.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.filmKey.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.manufacturer.toLowerCase().indexOf(filters.film.toLowerCase()) === -1
  ) {
    return false;
  }

  if (filters.width && String(box.widthIn) !== filters.width) {
    return false;
  }

  return true;
}

function getReportsSummaryService_(params) {
  var filters = {
    warehouse: asTrimmedString_(params.warehouse).toUpperCase(),
    manufacturer: asTrimmedString_(params.manufacturer),
    film: asTrimmedString_(params.film),
    width: asTrimmedString_(params.width),
    from: asTrimmedString_(params.from),
    to: asTrimmedString_(params.to)
  };
  var allBoxes = listAllBoxes_().concat(readSheetBoxes_('IL', true)).concat(readSheetBoxes_('MS', true));
  var activeBoxes = listAllBoxes_();
  var widthGroups = {};
  var availableFeetByWidth = [];
  var neverCheckedOut = [];
  var zeroedByMonthMap = {};
  var zeroedByMonth = [];
  var index;

  for (index = 0; index < activeBoxes.length; index += 1) {
    var activeBox = activeBoxes[index];
    if (!boxMatchesReportFilters_(activeBox, filters)) {
      continue;
    }

    var widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0
      };
    }

    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (var widthGroupKey in widthGroups) {
    if (Object.prototype.hasOwnProperty.call(widthGroups, widthGroupKey)) {
      availableFeetByWidth.push(widthGroups[widthGroupKey]);
    }
  }

  availableFeetByWidth.sort(function(a, b) {
    return a.widthIn - b.widthIn;
  });

  for (index = 0; index < allBoxes.length; index += 1) {
    var box = allBoxes[index];
    if (!boxMatchesReportFilters_(box, filters)) {
      continue;
    }

    if (box.receivedDate && !box.hasEverBeenCheckedOut) {
      if (filters.from && box.receivedDate < filters.from) {
        continue;
      }

      if (filters.to && box.receivedDate > filters.to) {
        continue;
      }

      neverCheckedOut.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        receivedDate: box.receivedDate,
        status: box.status,
        feetAvailable: box.feetAvailable
      });
    }

    if (box.status === 'ZEROED' && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }

      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }

      var monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort(function(a, b) {
    if (a.receivedDate !== b.receivedDate) {
      return a.receivedDate < b.receivedDate ? -1 : 1;
    }

    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  for (var month in zeroedByMonthMap) {
    if (Object.prototype.hasOwnProperty.call(zeroedByMonthMap, month)) {
      zeroedByMonth.push({
        month: month,
        zeroedCount: zeroedByMonthMap[month]
      });
    }
  }

  zeroedByMonth.sort(function(a, b) {
    return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
  });

  return {
    data: {
      availableFeetByWidth: availableFeetByWidth,
      neverCheckedOut: neverCheckedOut,
      zeroedByMonth: zeroedByMonth
    }
  };
}

function addBoxService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var boxId = requireString_(payload.boxId, 'BoxID');
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    if (findRowByBoxIdAcrossWarehouses_(boxId, true)) {
      throw new Error('A box with this BoxID already exists.');
    }

    var box = buildBoxFromPayload_(payload, warnings, null);
    applyAddOrEditWarnings_(warnings, null, box);
    var rowIndex = appendBoxRow_(box.warehouse, box);

    if (asTrimmedString_(payload.filmOrderId)) {
      var linkedOrder = linkBoxToFilmOrder_(payload.filmOrderId, box, user);
      warnings.push(
        'Box ' +
          box.boxId +
          ' was linked to Film Order ' +
          linkedOrder.filmOrderId +
          ' for job ' +
          linkedOrder.jobNumber +
          '.'
      );

      if (box.receivedDate && box.status === 'IN_STOCK') {
        box.rowIndex = rowIndex;
        box = processLinkedFilmOrderReceipt_(box, user, warnings);
        updateBoxRow_(box.warehouse, rowIndex, box);
      }
    }

    var publicBox = toPublicBox_(box);
    var logId = appendAudit_(
      'ADD_BOX',
      box.boxId,
      null,
      publicBox,
      user,
      asTrimmedString_(payload.auditNote)
    );

    return {
      data: {
        box: publicBox,
        logId: logId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function updateBoxService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var existing = findRowByBoxIdAcrossWarehouses_(payload.boxId, true);
  var lock = LockService.getScriptLock();
  var requestedMoveToZeroed = payload.moveToZeroed === true || String(payload.moveToZeroed) === 'true';

  if (!existing) {
    throw new Error('Box not found.');
  }

  lock.waitLock(30000);

  try {
    existing = findRowByBoxIdAcrossWarehouses_(payload.boxId, true);
    if (!existing) {
      throw new Error('Box not found.');
    }

    if (existing.useZeroed || existing.box.status === 'ZEROED') {
      throw new Error('Zeroed boxes cannot be edited directly. Use audit undo instead.');
    }

    var updatedBox = buildBoxFromPayload_(payload, warnings, existing.box);
    if (
      existing.box.status !== 'CHECKED_OUT' &&
      existing.box.status !== 'RETIRED' &&
      deriveLifecycleStatus_(existing.box.receivedDate) === 'ORDERED' &&
      updatedBox.status === 'IN_STOCK'
    ) {
      updatedBox.feetAvailable = updatedBox.initialFeet;
    }

    applyAddOrEditWarnings_(warnings, existing.box, updatedBox);

    var auditAction = 'UPDATE_BOX';
    var autoMoveToZeroed = shouldAutoMoveToZeroed_(existing.box, updatedBox);
    var moveToZeroed = requestedMoveToZeroed || autoMoveToZeroed;
    var reachedZeroState =
      Boolean(updatedBox.receivedDate) &&
      (updatedBox.feetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

    if (moveToZeroed) {
      if (!autoMoveToZeroed) {
        throw new Error(
          'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
        );
      }

      if (findZeroedRowByBoxIdAcrossWarehouses_(updatedBox.boxId)) {
        throw new Error('A box with this BoxID already exists in zeroed out inventory.');
      }

      stampZeroedMetadata_(updatedBox, user, payload.auditNote);
      var cancelledAllocationCount = cancelActiveAllocationsForBox_(
        updatedBox.boxId,
        user,
        'Auto-cancelled because the box was moved to zeroed out inventory.'
      );
      appendBoxRow_(existing.warehouse, updatedBox, true);
      deleteBoxRow_(existing.warehouse, existing.rowIndex);
      auditAction = 'ZERO_OUT_BOX';

      if (autoMoveToZeroed && !requestedMoveToZeroed) {
        warnings.push(
          'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
        );
      }

      if (cancelledAllocationCount > 0) {
        warnings.push(
          cancelledAllocationCount +
            ' active allocation' +
            (cancelledAllocationCount === 1 ? ' was' : 's were') +
            ' cancelled because the box moved to zeroed out inventory.'
        );
      }
    } else {
      if (reachedZeroState && !hasPositivePhysicalFeet_(existing.box)) {
        warnings.push(
          'Box stayed in active inventory because it has not had Available Feet above 0 yet.'
        );
      }
      updatedBox.rowIndex = existing.rowIndex;
      updatedBox = processLinkedFilmOrderReceipt_(updatedBox, user, warnings);
      updateBoxRow_(existing.warehouse, existing.rowIndex, updatedBox);
    }

    var publicBefore = toPublicBox_(existing.box);
    var publicAfter = toPublicBox_(updatedBox);
    var logId = appendAudit_(
      auditAction,
      updatedBox.boxId,
      publicBefore,
      publicAfter,
      user,
      asTrimmedString_(payload.auditNote)
    );

    return {
      data: {
        box: publicAfter,
        logId: logId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function setBoxStatusService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var status = assertBoxStatus_(payload.status);
  var lock = LockService.getScriptLock();

  if (status === 'ORDERED') {
    throw new Error('ORDERED is derived from ReceivedDate and cannot be set manually.');
  }

  if (status === 'RETIRED') {
    throw new Error('RETIRED status is no longer supported.');
  }

  if (status === 'ZEROED') {
    throw new Error('ZEROED status is assigned automatically when a received box reaches 0.');
  }

  lock.waitLock(30000);

  try {
    var existing = findRowByBoxIdAcrossWarehouses_(payload.boxId, true);
    if (!existing) {
      throw new Error('Box not found.');
    }

    if (deriveLifecycleStatus_(existing.box.receivedDate) === 'ORDERED') {
      throw new Error('Add a ReceivedDate on or before today before changing status.');
    }

    if (existing.useZeroed || existing.box.status === 'ZEROED') {
      throw new Error('Zeroed boxes cannot change status directly. Use audit undo instead.');
    }

    if (existing.box.status === 'RETIRED') {
      throw new Error('Retired boxes cannot change status directly. Use audit undo instead.');
    }

    var updatedBox = cloneObject_(existing.box);
    var auditAction = 'SET_STATUS';

    if (status === 'CHECKED_OUT') {
      var jobNumber = getCheckoutJobNumberFromAuditNotes_(payload.auditNote);
      if (!jobNumber) {
        throw new Error('A checkout job number is required.');
      }

      updatedBox.status = 'CHECKED_OUT';
      updatedBox.hasEverBeenCheckedOut = true;
      updatedBox.lastCheckoutJob = jobNumber;
      updatedBox.lastCheckoutDate = getTodayDateString_();
      updatedBox.zeroedDate = '';
      updatedBox.zeroedReason = '';
      updatedBox.zeroedBy = '';
      applyCheckoutWarnings_(warnings, existing.box);
      var allocationResolution = resolveAllocationsForCheckout_(updatedBox.boxId, jobNumber, user);
      if (allocationResolution.fulfilledCount > 0) {
        warnings.push(
          'Fulfilled ' +
            allocationResolution.fulfilledCount +
            ' allocation' +
            (allocationResolution.fulfilledCount === 1 ? '' : 's') +
            ' totaling ' +
            allocationResolution.fulfilledFeet +
            ' LF for job ' +
            jobNumber +
            '.'
        );
      }

      if (allocationResolution.otherJobs.length > 0) {
        warnings.push(
          'This box still has active allocations for ' +
            allocationResolution.otherJobs.join(', ') +
            '.'
        );
      }
      updateBoxRow_(existing.warehouse, existing.rowIndex, updatedBox);
    } else {
      updatedBox.status = 'IN_STOCK';
      updatedBox.lastRollWeightLbs = coerceNonNegativeNumber_(payload.lastRollWeightLbs, 'LastRollWeightLbs');
      updatedBox.lastWeighedDate = getTodayDateString_();
      var physicalFeetAvailable = updatedBox.feetAvailable;

      if (
        updatedBox.coreWeightLbs !== null &&
        updatedBox.lfWeightLbsPerFt !== null &&
        updatedBox.lfWeightLbsPerFt > 0
      ) {
        physicalFeetAvailable = deriveFeetAvailableFromRollWeight_(
          updatedBox.lastRollWeightLbs,
          updatedBox.coreWeightLbs,
          updatedBox.lfWeightLbsPerFt,
          updatedBox.initialFeet
        );
      } else {
        warnings.push(
          'Available Feet could not be recalculated because this box is missing core or LF weight metadata.'
        );
      }

      var activeAllocatedFeetAfterCheckIn = getActiveAllocatedFeetForBox_(updatedBox.boxId);
      updatedBox.feetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeetAfterCheckIn, 0);
      var willAutoZero =
        Boolean(updatedBox.receivedDate) &&
        existing.box.initialFeet > 0 &&
        (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

      applyCheckInWarnings_(warnings, existing.box, updatedBox, willAutoZero);
      if (activeAllocatedFeetAfterCheckIn > physicalFeetAvailable) {
        warnings.push(
          'This box now has more LF allocated to future jobs than the weight-based remaining feet.'
        );
      } else if (activeAllocatedFeetAfterCheckIn > 0 && updatedBox.feetAvailable === 0) {
        warnings.push('All remaining LF on this box is reserved by active allocations.');
      }

      var checkoutAudit = findLatestCheckoutAuditEntryByBoxId_(updatedBox.boxId);
      var checkoutJob = asTrimmedString_(existing.box.lastCheckoutJob);
      var checkoutDate = asTrimmedString_(existing.box.lastCheckoutDate);
      var checkoutUser = '';

      if (checkoutAudit) {
        if (!checkoutJob) {
          checkoutJob = getCheckoutJobNumberFromAuditNotes_(checkoutAudit.notes);
        }

        if (!checkoutDate) {
          checkoutDate = asTrimmedString_(checkoutAudit.date);
        }

        checkoutUser = asTrimmedString_(checkoutAudit.user);
      }

      if (!checkoutJob) {
        checkoutJob = 'UNKNOWN';
        warnings.push('Roll history was logged with UNKNOWN job number because no checkout job was saved.');
      }

      if (!checkoutDate) {
        checkoutDate = getTodayDateString_();
      }

      var checkedOutWeight = existing.box.lastRollWeightLbs;
      var weightDelta =
        checkedOutWeight === null
          ? null
          : roundToDecimals_(checkedOutWeight - updatedBox.lastRollWeightLbs, 2);

      if (checkedOutWeight === null) {
        warnings.push(
          'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
        );
      }

      appendRollWeightLog_({
        logId: '',
        boxId: updatedBox.boxId,
        warehouse: updatedBox.warehouse,
        manufacturer: updatedBox.manufacturer,
        filmName: updatedBox.filmName,
        widthIn: updatedBox.widthIn,
        jobNumber: checkoutJob,
        checkedOutAt: checkoutDate,
        checkedOutBy: checkoutUser,
        checkedOutWeightLbs: checkedOutWeight,
        checkedInAt: new Date().toISOString(),
        checkedInBy: asTrimmedString_(user),
        checkedInWeightLbs: updatedBox.lastRollWeightLbs,
        weightDeltaLbs: weightDelta,
        feetBefore: existing.box.feetAvailable,
        feetAfter: updatedBox.feetAvailable,
        notes: asTrimmedString_(payload.auditNote)
      });

      updatedBox.lastCheckoutJob = '';
      updatedBox.lastCheckoutDate = '';

      var reachedZeroState =
        Boolean(updatedBox.receivedDate) &&
        (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);
      var autoMoveToZeroed = willAutoZero;

      if (autoMoveToZeroed) {
        if (findZeroedRowByBoxIdAcrossWarehouses_(updatedBox.boxId)) {
          throw new Error('A box with this BoxID already exists in zeroed out inventory.');
        }

        stampZeroedMetadata_(updatedBox, user, payload.auditNote);
        var cancelledAllocationCount = cancelActiveAllocationsForBox_(
          updatedBox.boxId,
          user,
          'Auto-cancelled because the box was moved to zeroed out inventory.'
        );
        appendBoxRow_(existing.warehouse, updatedBox, true);
        deleteBoxRow_(existing.warehouse, existing.rowIndex);
        auditAction = 'ZERO_OUT_BOX';
        warnings.push(
          'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
        );

        if (cancelledAllocationCount > 0) {
          warnings.push(
            cancelledAllocationCount +
              ' active allocation' +
              (cancelledAllocationCount === 1 ? ' was' : 's were') +
              ' cancelled because the box moved to zeroed out inventory.'
          );
        }
      } else {
        if (reachedZeroState && existing.box.feetAvailable <= 0) {
          warnings.push(
            'Box stayed in active inventory because it has not had Available Feet above 0 yet.'
          );
        }

        updateBoxRow_(existing.warehouse, existing.rowIndex, updatedBox);
      }
    }

    var publicBefore = toPublicBox_(existing.box);
    var publicAfter = toPublicBox_(updatedBox);
    var logId = appendAudit_(
      auditAction,
      updatedBox.boxId,
      publicBefore,
      publicAfter,
      user,
      asTrimmedString_(payload.auditNote)
    );

    return {
      data: {
        box: publicAfter,
        logId: logId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}


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
  var sheet = getAuditSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, AUDIT_HEADERS_.length).getValues();
  var entries = [];

  for (var index = 0; index < rows.length; index += 1) {
    var entry = parseAuditRow_(rows[index]);
    if (entry.logId) {
      entries.push(entry);
    }
  }

  return entries;
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


// Paste into Apps Script file: routes.gs

var ROUTES_ = {
  'GET /health': healthService_,
  'GET /boxes/search': searchBoxesService_,
  'GET /boxes/get': getBoxService_,
  'GET /audit/list': listAuditService_,
  'GET /audit/by-box': getAuditByBoxService_,
  'GET /allocations/by-box': getAllocationsByBoxService_,
  'GET /allocations/jobs': getAllocationJobsService_,
  'GET /allocations/by-job': getAllocationByJobService_,
  'GET /allocations/preview': getAllocationPreviewService_,
  'GET /jobs/list': getJobsListService_,
  'GET /jobs/get': getJobService_,
  'GET /film-orders/list': getFilmOrdersService_,
  'GET /film-data/catalog': getFilmCatalogService_,
  'GET /roll-history/by-box': getRollHistoryByBoxService_,
  'GET /reports/summary': getReportsSummaryService_,
  'POST /boxes/search': searchBoxesService_,
  'POST /boxes/get': getBoxService_,
  'POST /audit/list': listAuditService_,
  'POST /audit/by-box': getAuditByBoxService_,
  'POST /allocations/by-box': getAllocationsByBoxService_,
  'POST /allocations/jobs': getAllocationJobsService_,
  'POST /allocations/by-job': getAllocationByJobService_,
  'POST /allocations/preview': getAllocationPreviewService_,
  'POST /allocations/apply': applyAllocationPlanService_,
  'POST /jobs/list': getJobsListService_,
  'POST /jobs/get': getJobService_,
  'POST /jobs/create': createJobService_,
  'POST /jobs/update': updateJobService_,
  'POST /roll-history/by-box': getRollHistoryByBoxService_,
  'POST /film-orders/list': getFilmOrdersService_,
  'POST /film-data/catalog': getFilmCatalogService_,
  'POST /film-orders/create': createFilmOrderService_,
  'POST /film-orders/cancel': cancelJobService_,
  'POST /reports/summary': getReportsSummaryService_,
  'POST /boxes/add': addBoxService_,
  'POST /allocations/add': allocateBoxService_,
  'POST /boxes/update': updateBoxService_,
  'POST /boxes/set-status': setBoxStatusService_,
  'POST /audit/undo': undoAuditService_
};

function routeRequest_(method, e) {
  try {
    var payload = method === 'GET' ? (e.parameter || {}) : parseJsonBody_(e);
    var route = resolveRoute_(e);

    if (method === 'POST' && route === '/' && payload && payload.path) {
      route = String(payload.path);
      if (route.charAt(0) !== '/') {
        route = '/' + route;
      }
    }

    var key = method + ' ' + route;
    var handler = ROUTES_[key];

    if (!handler) {
      return jsonResponse_(errorEnvelope_('Route not found: ' + route));
    }

    var result = handler(payload, e) || {};

    return jsonResponse_(successEnvelope_(result.data, result.warnings));
  } catch (error) {
    return jsonResponse_(
      errorEnvelope_(error && error.message ? error.message : 'Unexpected server error.')
    );
  }
}

