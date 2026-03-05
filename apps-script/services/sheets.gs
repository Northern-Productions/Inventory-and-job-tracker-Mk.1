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
