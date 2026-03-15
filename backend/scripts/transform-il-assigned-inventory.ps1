param(
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$WorkbookPath = "",
  [string]$OutputDir = "",
  [switch]$AllowOptionalHyphenDescriptions
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$profileConfigs = @{
  IL = [pscustomobject]@{
    default_workbook = "C:\Users\Rober\Downloads\IL Assigned Inventory.xlsx"
    default_output_dir = "backend/migration-dry-runs/il-assigned"
    target_sheets = @(
      "Llumar",
      "3M Solar",
      "Fasara",
      "Solar Guard",
      "Security",
      "Di-Noc",
      "Avery Dennison",
      "Solyx",
      "Vinyl",
      "ASWFVKOOL"
    )
    default_prefix = "IL1"
    legacy_m_prefix = "MS1"
    allow_optional_hyphen = $false
    manufacturer_map = @{
      "FASARA" = "3M Fasara"
      "SOLAR GUARD" = "Solar Gard"
    }
    baseline_accepted = 644
    baseline_skipped = 36
  }
  MS = [pscustomobject]@{
    default_workbook = "C:\Users\Rober\Downloads\MS Inventory.xlsx"
    default_output_dir = "backend/migration-dry-runs/ms-inventory"
    target_sheets = @(
      "3M Solar",
      "Fasara",
      "Avery Dennison",
      "LlumarVista",
      "Security",
      "Solar Guard",
      "Solyx",
      "Madico",
      "Di-Noc",
      "Vinyl"
    )
    default_prefix = "MS1"
    legacy_m_prefix = "MS1"
    allow_optional_hyphen = $true
    manufacturer_map = @{
      "FASARA" = "3M Fasara"
      "SOLAR GUARD" = "Solar Gard"
      "LLUMARVISTA" = "Llumar"
      "MADICO" = "ASWFVKOOL"
    }
    baseline_accepted = $null
    baseline_skipped = $null
  }
}

$config = $profileConfigs[$Profile]
if ($null -eq $config) {
  throw "Unsupported profile: $Profile"
}

if ([string]::IsNullOrWhiteSpace($WorkbookPath)) {
  $WorkbookPath = [string]$config.default_workbook
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = [string]$config.default_output_dir
}

$allowOptionalHyphen = [bool]$config.allow_optional_hyphen
if ($PSBoundParameters.ContainsKey("AllowOptionalHyphenDescriptions")) {
  $allowOptionalHyphen = $AllowOptionalHyphenDescriptions.IsPresent
}

$targetSheetNames = [string[]]$config.target_sheets
$defaultPrefix = [string]$config.default_prefix
$legacyMPrefix = [string]$config.legacy_m_prefix
$manufacturerMap = [hashtable]$config.manufacturer_map

$boxesRawColumns = @(
  "BoxID",
  "Manufacturer",
  "FilmName",
  "WidthIn",
  "InitialFeet",
  "FeetAvailable",
  "LotRun",
  "Status",
  "OrderDate",
  "ReceivedDate",
  "InitialWeightLbs",
  "LastRollWeightLbs",
  "LastWeighedDate",
  "FilmKey",
  "CoreType",
  "CoreWeightLbs",
  "LfWeightLbsPerFt",
  "PurchaseCost",
  "Notes",
  "HasEverBeenCheckedOut",
  "LastCheckoutJob",
  "LastCheckoutDate",
  "ZeroedDate",
  "ZeroedReason",
  "ZeroedBy"
)

if (-not (Test-Path -LiteralPath $WorkbookPath)) {
  throw "Workbook not found: $WorkbookPath"
}

function Get-ZipEntryText {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Compression.ZipArchive]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$EntryPath
  )

  $entry = $Archive.GetEntry($EntryPath)
  if (-not $entry) {
    return $null
  }

  $reader = [System.IO.StreamReader]::new($entry.Open())
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function Get-ColumnIndexFromCellRef {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CellRef
  )

  if ([string]::IsNullOrWhiteSpace($CellRef)) {
    return -1
  }

  $letters = [regex]::Replace($CellRef.ToUpperInvariant(), "[^A-Z]", "")
  if ([string]::IsNullOrWhiteSpace($letters)) {
    return -1
  }

  $sum = 0
  foreach ($char in $letters.ToCharArray()) {
    $sum = ($sum * 26) + ([int][char]$char - [int][char]"A" + 1)
  }

  return $sum - 1
}

function Resolve-CellValue {
  param(
    [Parameter(Mandatory = $true)]
    [System.Xml.XmlElement]$Cell,
    [Parameter(Mandatory = $true)]
    [string[]]$SharedStrings
  )

  $cellType = [string]$Cell.GetAttribute("t")
  $valueNode = $Cell.SelectSingleNode('./*[local-name()="v"]')

  if ($cellType -eq "inlineStr") {
    $parts = @()
    $textNodes = $Cell.SelectNodes('./*[local-name()="is"]//*[local-name()="t"]')
    foreach ($node in $textNodes) {
      $parts += [string]$node.InnerText
    }
    return ($parts -join "")
  }

  if (-not $valueNode) {
    return ""
  }

  $raw = [string]$valueNode.InnerText

  if ($cellType -eq "s") {
    $index = 0
    if ([int]::TryParse($raw, [ref]$index) -and $index -ge 0 -and $index -lt $SharedStrings.Count) {
      return $SharedStrings[$index]
    }
  }

  if ($cellType -eq "b") {
    if ($raw -eq "1") {
      return "TRUE"
    }
    return "FALSE"
  }

  return $raw
}

function Get-RowValueMap {
  param(
    [Parameter(Mandatory = $true)]
    [System.Xml.XmlElement]$Row,
    [Parameter(Mandatory = $true)]
    [string[]]$SharedStrings
  )

  $map = @{}
  $cells = $Row.SelectNodes('./*[local-name()="c"]')

  foreach ($cell in $cells) {
    $index = Get-ColumnIndexFromCellRef -CellRef ([string]$cell.GetAttribute("r"))
    if ($index -lt 0) {
      continue
    }
    $map[$index] = Resolve-CellValue -Cell $cell -SharedStrings $SharedStrings
  }

  return $map
}

function Normalize-HeaderText {
  param(
    [string]$Value
  )

  if ($null -eq $Value) {
    return ""
  }

  return ([regex]::Replace($Value.Trim(), "\s+", " ")).ToLowerInvariant()
}

function Get-QuantityColumnIndex {
  param(
    [AllowEmptyCollection()]
    [AllowEmptyString()]
    [string[]]$Headers
  )

  for ($i = 0; $i -lt $Headers.Count; $i++) {
    if ((Normalize-HeaderText -Value $Headers[$i]) -eq "ft on hand") {
      return $i
    }
  }

  for ($i = 0; $i -lt $Headers.Count; $i++) {
    if ((Normalize-HeaderText -Value $Headers[$i]) -like "*ft on hand*") {
      return $i
    }
  }

  for ($i = 0; $i -lt $Headers.Count; $i++) {
    $normalized = Normalize-HeaderText -Value $Headers[$i]
    if ($normalized -match "initial amount|start amount|amount") {
      return $i
    }
  }

  return -1
}

function Get-LotColumnIndex {
  param(
    [AllowEmptyCollection()]
    [AllowEmptyString()]
    [string[]]$Headers
  )

  for ($i = 0; $i -lt $Headers.Count; $i++) {
    $normalized = Normalize-HeaderText -Value $Headers[$i]
    if ($normalized -match "\blot\b") {
      return $i
    }
  }

  return -1
}

function Test-LotLikeValue {
  param(
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }

  $trimmed = $Value.Trim()
  $normalized = $trimmed.ToUpperInvariant()
  if ($normalized -in @("NA", "N/A", "NONE", "NULL", "DONE")) {
    return $false
  }

  $numeric = 0.0
  $isNumericOnly = [double]::TryParse(
    $trimmed,
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [ref]$numeric
  )
  if ($isNumericOnly) {
    return $false
  }

  if ($trimmed -match "[A-Za-z]") {
    return $true
  }

  if ($trimmed -match "[-/]") {
    return $true
  }

  return $trimmed.Length -ge 6
}

function Get-LotColumnIndexFallback {
  param(
    [AllowEmptyCollection()]
    [object[]]$Rows,
    [AllowEmptyCollection()]
    [AllowEmptyString()]
    [string[]]$SharedStrings
  )

  $candidateIndex = 1
  $sampleRows = @($Rows | Where-Object { [int]$_.GetAttribute("r") -gt 1 } | Select-Object -First 40)
  if ($sampleRows.Count -eq 0) {
    return -1
  }

  $nonEmpty = 0
  $lotLike = 0
  foreach ($row in $sampleRows) {
    $valueMap = Get-RowValueMap -Row $row -SharedStrings $SharedStrings
    if (-not $valueMap.ContainsKey($candidateIndex)) {
      continue
    }

    $raw = [string]$valueMap[$candidateIndex]
    if ([string]::IsNullOrWhiteSpace($raw)) {
      continue
    }

    $nonEmpty++
    if (Test-LotLikeValue -Value $raw) {
      $lotLike++
    }
  }

  if ($nonEmpty -lt 5) {
    return -1
  }

  $score = $lotLike / [double]$nonEmpty
  if ($score -ge 0.6) {
    return $candidateIndex
  }

  return -1
}

function Convert-ToMonthEndDateYmd {
  param(
    [int]$Year,
    [int]$Month
  )

  try {
    $first = [datetime]::new($Year, $Month, 1)
    return $first.AddMonths(1).AddDays(-1).ToString("yyyy-MM-dd")
  } catch {
    return $null
  }
}

function Get-MonthNumberFromName {
  param(
    [string]$MonthToken
  )

  $month = "$MonthToken".Trim().ToLowerInvariant()
  switch -Regex ($month) {
    "^jan" { return 1 }
    "^feb" { return 2 }
    "^mar" { return 3 }
    "^apr" { return 4 }
    "^may" { return 5 }
    "^jun" { return 6 }
    "^jul" { return 7 }
    "^aug" { return 8 }
    "^sep" { return 9 }
    "^oct" { return 10 }
    "^nov" { return 11 }
    "^dec" { return 12 }
    default { return 0 }
  }
}

function Get-InventoryDateFromHeaders {
  param(
    [AllowEmptyCollection()]
    [AllowEmptyString()]
    [string[]]$Headers
  )

  foreach ($header in $Headers) {
    if ([string]::IsNullOrWhiteSpace($header)) {
      continue
    }

    $match = [regex]::Match($header, "(?<m>\d{1,2})/(?<d>\d{1,2})/(?<y>\d{2,4})")
    if (-not $match.Success) {
      continue
    }

    $month = [int]$match.Groups["m"].Value
    $day = [int]$match.Groups["d"].Value
    $year = [int]$match.Groups["y"].Value
    if ($year -lt 100) {
      $year += 2000
    }

    try {
      $date = [datetime]::new($year, $month, $day)
      return $date.ToString("yyyy-MM-dd")
    } catch {
      continue
    }
  }

  foreach ($header in $Headers) {
    if ([string]::IsNullOrWhiteSpace($header)) {
      continue
    }

    $monthYear = [regex]::Match(
      $header,
      "(?i)(?<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*,?\s*(?<year>\d{4})"
    )
    if (-not $monthYear.Success) {
      continue
    }

    $month = Get-MonthNumberFromName -MonthToken $monthYear.Groups["month"].Value
    if ($month -le 0) {
      continue
    }

    $year = [int]$monthYear.Groups["year"].Value
    $monthEnd = Convert-ToMonthEndDateYmd -Year $year -Month $month
    if (-not [string]::IsNullOrWhiteSpace($monthEnd)) {
      return $monthEnd
    }
  }

  return $null
}

function Parse-Quantity {
  param(
    [string]$RawValue
  )

  if ([string]::IsNullOrWhiteSpace($RawValue)) {
    return $null
  }

  $clean = $RawValue.Trim().Replace(",", "").Replace("'", "")
  $clean = [regex]::Replace($clean, "[^0-9\.\-]", "")
  if ([string]::IsNullOrWhiteSpace($clean) -or $clean -eq "." -or $clean -eq "-" -or $clean -eq "-.") {
    return $null
  }

  $parsed = 0.0
  $parsedOk = [double]::TryParse(
    $clean,
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [ref]$parsed
  )

  if (-not $parsedOk) {
    return $null
  }

  return $parsed
}

function Normalize-TrailingLetterSuffix {
  param(
    [string]$BoxId
  )

  if ([string]::IsNullOrWhiteSpace($BoxId)) {
    return ""
  }

  $trimmed = $BoxId.Trim().ToUpperInvariant()
  $match = [regex]::Match($trimmed, "^(?<prefix>[A-Z]{2}[1-9][0-9]*)-(?<number>\d+)[A-Z]$")
  if ($match.Success) {
    return "$($match.Groups["prefix"].Value)-$($match.Groups["number"].Value)"
  }

  return $trimmed
}

function Normalize-CanonicalBoxId {
  param(
    [string]$RawBoxId
  )

  if ([string]::IsNullOrWhiteSpace($RawBoxId)) {
    return ""
  }

  $clean = $RawBoxId.Trim().ToUpperInvariant()
  if ($clean -match "^(?<state>[A-Z]{2})-(?<suffix>[A-Z0-9]+)$") {
    $clean = "$($matches["state"])1-$($matches["suffix"])"
  }

  return Normalize-TrailingLetterSuffix -BoxId $clean
}

function Build-CanonicalBoxIdFromIdToken {
  param(
    [string]$IdToken,
    [string]$DefaultPrefix,
    [string]$LegacyMPrefix
  )

  $token = "$IdToken".Trim().ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($token)) {
    return ""
  }

  if ($token -match "^[A-Z]{2}[1-9][0-9]*-[A-Z0-9]+$") {
    return Normalize-CanonicalBoxId -RawBoxId $token
  }

  if ($token -match "^[A-Z]{2}-[A-Z0-9]+$") {
    return Normalize-CanonicalBoxId -RawBoxId $token
  }

  if ($token.StartsWith("M", [System.StringComparison]::OrdinalIgnoreCase) -and $token.Length -gt 1) {
    return Normalize-CanonicalBoxId -RawBoxId "$LegacyMPrefix-$($token.Substring(1))"
  }

  return Normalize-CanonicalBoxId -RawBoxId "$DefaultPrefix-$token"
}

function Resolve-ManufacturerName {
  param(
    [string]$SheetName,
    [hashtable]$ManufacturerMap
  )

  $name = "$SheetName".Trim()
  if ([string]::IsNullOrWhiteSpace($name)) {
    return $name
  }

  $key = $name.ToUpperInvariant()
  if ($null -ne $ManufacturerMap -and $ManufacturerMap.ContainsKey($key)) {
    return [string]$ManufacturerMap[$key]
  }

  return $name
}

function Parse-Description {
  param(
    [string]$RawDescription,
    [string]$DefaultPrefix,
    [string]$LegacyMPrefix,
    [bool]$AllowOptionalHyphenDescriptions = $false
  )

  $description = "$RawDescription".Trim()
  if ([string]::IsNullOrWhiteSpace($description)) {
    return [pscustomobject]@{
      Success = $false
      Reason = "malformed_description"
      IdToken = ""
      CandidateBoxId = ""
      FilmName = ""
      WidthIn = $null
    }
  }

  $idMatch = [regex]::Match($description, "^(?<id>[A-Za-z]{2}[1-9][0-9]*-[A-Za-z0-9]+)\s*-\s*(?<rest>.+)$")
  if (-not $idMatch.Success) {
    $idMatch = [regex]::Match($description, "^(?<id>[A-Za-z0-9]{2,16})\s*-\s*(?<rest>.+)$")
  }
  if (-not $idMatch.Success -and $AllowOptionalHyphenDescriptions) {
    $idMatch = [regex]::Match($description, "^(?<id>[A-Za-z0-9]{2,16})\s+(?<rest>.+)$")
  }

  if (-not $idMatch.Success) {
    return [pscustomobject]@{
      Success = $false
      Reason = "malformed_description"
      IdToken = ""
      CandidateBoxId = ""
      FilmName = ""
      WidthIn = $null
    }
  }

  $idToken = $idMatch.Groups["id"].Value.ToUpperInvariant()
  $rest = [regex]::Replace($idMatch.Groups["rest"].Value.Trim(), "\s+", " ")

  $widthMatch = [regex]::Match($rest, '(?<width>\d{2,3})\s*(?:"|IN(?:CH(?:ES)?)?)\s*$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $widthMatch.Success) {
    $widthMatch = [regex]::Match($rest, "(?<width>\d{2,3})\s*$")
  }

  if (-not $widthMatch.Success) {
    return [pscustomobject]@{
      Success = $false
      Reason = "missing_width"
      IdToken = $idToken
      CandidateBoxId = ""
      FilmName = $rest
      WidthIn = $null
    }
  }

  $widthIn = [int]$widthMatch.Groups["width"].Value
  if ($widthIn -le 0) {
    return [pscustomobject]@{
      Success = $false
      Reason = "missing_width"
      IdToken = $idToken
      CandidateBoxId = ""
      FilmName = $rest
      WidthIn = $null
    }
  }

  $filmName = [regex]::Replace($rest, '(?i)\s*\d{2,3}\s*(?:"|IN(?:CH(?:ES)?)?)\s*$', "")
  if ($filmName -eq $rest) {
    $filmName = [regex]::Replace($rest, "\s*\d{2,3}\s*$", "")
  }
  $filmName = [regex]::Replace($filmName.Trim(), "\s+", " ")

  if ([string]::IsNullOrWhiteSpace($filmName)) {
    return [pscustomobject]@{
      Success = $false
      Reason = "malformed_description"
      IdToken = $idToken
      CandidateBoxId = ""
      FilmName = ""
      WidthIn = $null
    }
  }

  $boxId = Build-CanonicalBoxIdFromIdToken -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
  if ([string]::IsNullOrWhiteSpace($boxId)) {
    return [pscustomobject]@{
      Success = $false
      Reason = "malformed_description"
      IdToken = $idToken
      CandidateBoxId = ""
      FilmName = $filmName
      WidthIn = $widthIn
    }
  }

  return [pscustomobject]@{
    Success = $true
    Reason = ""
    IdToken = $idToken
    CandidateBoxId = $boxId
    FilmName = $filmName
    WidthIn = $widthIn
  }
}

function New-BoxesRawRow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BoxId,
    [Parameter(Mandatory = $true)]
    [string]$Manufacturer,
    [Parameter(Mandatory = $true)]
    [string]$FilmName,
    [Parameter(Mandatory = $true)]
    [int]$WidthIn,
    [Parameter(Mandatory = $true)]
    [int]$Feet,
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$LotRun,
    [Parameter(Mandatory = $true)]
    [string]$InventoryDate,
    [Parameter(Mandatory = $true)]
    [string]$SourceSheet,
    [Parameter(Mandatory = $true)]
    [int]$SourceRow,
    [Parameter(Mandatory = $true)]
    [string]$RawDescription
  )

  $notes = "SourceSheet=$SourceSheet; SourceRow=$SourceRow; RawDescription=$RawDescription"
  $filmKey = "$($Manufacturer.ToUpperInvariant())|$($FilmName.ToUpperInvariant())"

  return [pscustomobject][ordered]@{
    BoxID = $BoxId
    Manufacturer = $Manufacturer
    FilmName = $FilmName
    WidthIn = "$WidthIn"
    InitialFeet = "$Feet"
    FeetAvailable = "$Feet"
    LotRun = $LotRun
    Status = "IN_STOCK"
    OrderDate = $InventoryDate
    ReceivedDate = $InventoryDate
    InitialWeightLbs = ""
    LastRollWeightLbs = ""
    LastWeighedDate = ""
    FilmKey = $filmKey
    CoreType = ""
    CoreWeightLbs = ""
    LfWeightLbsPerFt = ""
    PurchaseCost = ""
    Notes = $notes
    HasEverBeenCheckedOut = "false"
    LastCheckoutJob = ""
    LastCheckoutDate = ""
    ZeroedDate = ""
    ZeroedReason = ""
    ZeroedBy = ""
  }
}

function New-ExceptionRow {
  param(
    [string]$Sheet,
    [int]$RowNumber,
    [string]$Reason,
    [string]$RawDescription,
    [string]$RawQty,
    [string]$RawLot,
    [string]$ParsedIdCandidate,
    [string]$ParsedWidthCandidate,
    [string]$InventoryDate
  )

  return [pscustomobject][ordered]@{
    sheet = $Sheet
    row_number = $RowNumber
    reason = $Reason
    raw_description = $RawDescription
    raw_qty = $RawQty
    raw_lot = $RawLot
    parsed_id_candidate = $ParsedIdCandidate
    parsed_width_candidate = $ParsedWidthCandidate
    inventory_date = $InventoryDate
  }
}

function Get-CaulkDetectionReason {
  param(
    [string]$Manufacturer,
    [string]$FilmName,
    [string]$RawDescription
  )

  $combined = "$Manufacturer $FilmName $RawDescription".ToLowerInvariant()
  if ($combined -match "\bdow\s*995\b") {
    return "dow_995"
  }
  if ($combined -match "\bdow\s*795\b") {
    return "dow_795"
  }
  if ($combined -match "\bcaulk\b") {
    return "caulk_keyword"
  }
  if ($combined -match "\bsilicone\b") {
    return "silicone_keyword"
  }
  return ""
}

function Get-CaulkSuggestion {
  param(
    [string]$Manufacturer,
    [string]$FilmName,
    [string]$RawDescription
  )

  $detectionReason = Get-CaulkDetectionReason -Manufacturer $Manufacturer -FilmName $FilmName -RawDescription $RawDescription
  $suggestedManufacturer = "$Manufacturer".Trim()
  $suggestedProductName = "$FilmName".Trim()
  $suggestedProductCode = ""

  if ([string]::IsNullOrWhiteSpace($suggestedProductName)) {
    $suggestedProductName = "$RawDescription".Trim()
  }

  if ($detectionReason -like "dow_*") {
    $suggestedManufacturer = "3M"
  }

  if ($suggestedProductName -match "(?i)\bdow\s*(?<code>995|795)\b") {
    $suggestedProductCode = "DOW-$($matches["code"])"
  }

  return [pscustomobject]@{
    IsCaulkLike = -not [string]::IsNullOrWhiteSpace($detectionReason)
    DetectionReason = $detectionReason
    SuggestedManufacturer = $suggestedManufacturer
    SuggestedProductName = $suggestedProductName
    SuggestedProductCode = $suggestedProductCode
    SuggestedTubesPerCase = 16
  }
}

function New-CaulkCandidateRow {
  param(
    [string]$Sheet,
    [int]$RowNumber,
    [string]$InventoryDate,
    [string]$BoxIdCandidate,
    [string]$Manufacturer,
    [string]$FilmName,
    [int]$WidthIn,
    [int]$QuantityCases,
    [string]$LotRun,
    [string]$RawDescription,
    [string]$DetectionReason,
    [string]$SuggestedManufacturer,
    [string]$SuggestedProductName,
    [string]$SuggestedProductCode,
    [int]$SuggestedTubesPerCase
  )

  return [pscustomobject][ordered]@{
    source_sheet = $Sheet
    row_number = $RowNumber
    inventory_date = $InventoryDate
    box_id_candidate = $BoxIdCandidate
    warehouse_candidate = (Get-WarehouseBucketFromBoxId -BoxId $BoxIdCandidate)
    source_manufacturer = $Manufacturer
    source_film_name = $FilmName
    width_in = $WidthIn
    quantity_cases = $QuantityCases
    lot_run = $LotRun
    raw_description = $RawDescription
    detection_reason = $DetectionReason
    suggested_manufacturer = $SuggestedManufacturer
    suggested_product_name = $SuggestedProductName
    suggested_product_code = $SuggestedProductCode
    suggested_tubes_per_case = $SuggestedTubesPerCase
  }
}

function Get-CaulkCandidateKey {
  param(
    [string]$Sheet,
    [int]$RowNumber,
    [string]$BoxIdCandidate
  )

  return "$($Sheet.ToUpperInvariant())|$RowNumber|$($BoxIdCandidate.ToUpperInvariant())"
}

function New-CaulkReviewRow {
  param(
    [pscustomobject]$Candidate,
    [pscustomobject]$Existing
  )

  $decision = ""
  $canonicalManufacturer = [string]$Candidate.suggested_manufacturer
  $canonicalProductName = [string]$Candidate.suggested_product_name
  $canonicalProductCode = [string]$Candidate.suggested_product_code
  $canonicalTubesPerCase = [int]$Candidate.suggested_tubes_per_case
  $notes = ""

  if ($null -ne $Existing) {
    $decision = [string]$Existing.decision
    $canonicalManufacturer = [string]$Existing.canonical_manufacturer
    if ([string]::IsNullOrWhiteSpace($canonicalManufacturer)) {
      $canonicalManufacturer = [string]$Candidate.suggested_manufacturer
    }
    $canonicalProductName = [string]$Existing.canonical_product_name
    if ([string]::IsNullOrWhiteSpace($canonicalProductName)) {
      $canonicalProductName = [string]$Candidate.suggested_product_name
    }
    $canonicalProductCode = [string]$Existing.canonical_product_code
    if ([string]::IsNullOrWhiteSpace($canonicalProductCode)) {
      $canonicalProductCode = [string]$Candidate.suggested_product_code
    }
    $canonicalTubesPerCaseText = [string]$Existing.canonical_tubes_per_case
    $parsedCanonicalTubes = 0
    if ([int]::TryParse($canonicalTubesPerCaseText, [ref]$parsedCanonicalTubes) -and $parsedCanonicalTubes -gt 0) {
      $canonicalTubesPerCase = $parsedCanonicalTubes
    }
    $notes = [string]$Existing.notes
  }

  return [pscustomobject][ordered]@{
    source_sheet = [string]$Candidate.source_sheet
    row_number = [int]$Candidate.row_number
    box_id_candidate = [string]$Candidate.box_id_candidate
    decision = $decision
    canonical_manufacturer = $canonicalManufacturer
    canonical_product_name = $canonicalProductName
    canonical_product_code = $canonicalProductCode
    canonical_tubes_per_case = $canonicalTubesPerCase
    notes = $notes
  }
}

function Get-WarehouseBucketFromBoxId {
  param(
    [string]$BoxId
  )

  $normalized = "$BoxId".Trim().ToUpperInvariant()
  if ($normalized -match "^IL[1-9][0-9]*-") {
    return "IL"
  }
  if ($normalized -match "^MS[1-9][0-9]*-") {
    return "MS"
  }
  return "OTHER"
}

$outputPath = Join-Path -Path (Get-Location) -ChildPath $OutputDir
if (-not (Test-Path -LiteralPath $outputPath)) {
  [void](New-Item -Path $outputPath -ItemType Directory -Force)
}

$boxesCsvPath = Join-Path -Path $outputPath -ChildPath "boxes_raw.csv"
$exceptionsCsvPath = Join-Path -Path $outputPath -ChildPath "boxes_exceptions.csv"
$collisionsCsvPath = Join-Path -Path $outputPath -ChildPath "id_collisions.csv"
$summaryJsonPath = Join-Path -Path $outputPath -ChildPath "summary.json"
$caulkCandidatesCsvPath = Join-Path -Path $outputPath -ChildPath "caulk_raw_candidates.csv"
$caulkReviewCsvPath = Join-Path -Path $outputPath -ChildPath "caulk_review_decisions.csv"
$caulkFinalCsvPath = Join-Path -Path $outputPath -ChildPath "caulk_raw_final.csv"
$caulkSummaryJsonPath = Join-Path -Path $outputPath -ChildPath "caulk_summary.json"

foreach ($path in @(
    $boxesCsvPath,
    $exceptionsCsvPath,
    $collisionsCsvPath,
    $summaryJsonPath,
    $caulkCandidatesCsvPath,
    $caulkFinalCsvPath,
    $caulkSummaryJsonPath
  )) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($WorkbookPath)
try {
  $sharedStrings = @()
  $sharedStringsXmlText = Get-ZipEntryText -Archive $archive -EntryPath "xl/sharedStrings.xml"
  if ($sharedStringsXmlText) {
    [xml]$sharedStringsXml = $sharedStringsXmlText
    $stringNodes = $sharedStringsXml.SelectNodes('/*[local-name()="sst"]/*[local-name()="si"]')
    foreach ($node in $stringNodes) {
      $parts = @()
      $textNodes = $node.SelectNodes('.//*[local-name()="t"]')
      foreach ($textNode in $textNodes) {
        $parts += [string]$textNode.InnerText
      }
      $sharedStrings += ($parts -join "")
    }
  }

  [xml]$workbookXml = Get-ZipEntryText -Archive $archive -EntryPath "xl/workbook.xml"
  [xml]$relsXml = Get-ZipEntryText -Archive $archive -EntryPath "xl/_rels/workbook.xml.rels"
  if (-not $workbookXml -or -not $relsXml) {
    throw "Unable to read workbook XML metadata from $WorkbookPath"
  }

  $relationshipMap = @{}
  $relationshipNodes = $relsXml.SelectNodes('/*[local-name()="Relationships"]/*[local-name()="Relationship"]')
  foreach ($relationship in $relationshipNodes) {
    $relationshipMap[[string]$relationship.GetAttribute("Id")] = [string]$relationship.GetAttribute("Target")
  }

  $sheetNodeMap = @{}
  $sheetNodes = $workbookXml.SelectNodes('/*[local-name()="workbook"]/*[local-name()="sheets"]/*[local-name()="sheet"]')
  foreach ($sheetNode in $sheetNodes) {
    $sheetNameRaw = [string]$sheetNode.GetAttribute("name")
    $sheetName = $sheetNameRaw.Trim()
    $relationshipId = [string]$sheetNode.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
    $target = $relationshipMap[$relationshipId]
    if ([string]::IsNullOrWhiteSpace($target)) {
      continue
    }
    if (-not $target.StartsWith("xl/")) {
      $target = "xl/" + $target.TrimStart("/")
    }
    $sheetNodeMap[$sheetName] = [pscustomobject]@{
      Name = $sheetName
      RawName = $sheetNameRaw
      Target = $target
    }
  }

  $missingSheets = @()
  foreach ($sheetName in $targetSheetNames) {
    if (-not $sheetNodeMap.ContainsKey($sheetName)) {
      $missingSheets += $sheetName
    }
  }
  if ($missingSheets.Count -gt 0) {
    throw "Missing expected sheet(s): $($missingSheets -join ', ')"
  }

  $boxesRows = New-Object System.Collections.Generic.List[object]
  $exceptionsRows = New-Object System.Collections.Generic.List[object]
  $collisionsRows = New-Object System.Collections.Generic.List[object]
  $caulkCandidateRows = New-Object System.Collections.Generic.List[object]
  $seenBoxIds = @{}
  $warehouseCounts = @{ IL = 0; MS = 0; OTHER = 0 }
  $globalReasonCounts = @{}
  $caulkReasonCounts = @{}
  $perSheetSummary = New-Object System.Collections.Generic.List[object]

  foreach ($sheetName in $targetSheetNames) {
    $sheetMeta = $sheetNodeMap[$sheetName]
    [xml]$sheetXml = Get-ZipEntryText -Archive $archive -EntryPath $sheetMeta.Target
    if (-not $sheetXml) {
      throw "Failed to read worksheet XML for '$sheetName'"
    }

    $rows = $sheetXml.SelectNodes('/*[local-name()="worksheet"]/*[local-name()="sheetData"]/*[local-name()="row"]')
    if (-not $rows -or $rows.Count -eq 0) {
      $perSheetSummary.Add([pscustomobject]@{
          sheet = $sheetName
          inventory_date = $null
          quantity_column = $null
          lot_column = $null
          accepted_rows = 0
          skipped_rows = 0
          caulk_routed_rows = 0
          reasons = @{}
        })
      continue
    }

    $headerMap = @{}
    $headerRow = $rows | Where-Object { [string]$_.GetAttribute("r") -eq "1" } | Select-Object -First 1
    if ($headerRow) {
      $headerValueMap = Get-RowValueMap -Row $headerRow -SharedStrings $sharedStrings
      foreach ($key in $headerValueMap.Keys) {
        $headerMap[$key] = [string]$headerValueMap[$key]
      }
    }

    $headers = @()
    if ($headerMap.Count -gt 0) {
      $maxHeaderIndex = [int](($headerMap.Keys | Measure-Object -Maximum).Maximum)
      for ($i = 0; $i -le $maxHeaderIndex; $i++) {
        if ($headerMap.ContainsKey($i)) {
          $headers += [string]$headerMap[$i]
        } else {
          $headers += ""
        }
      }
    }

    $quantityColumnIndex = Get-QuantityColumnIndex -Headers $headers
    $lotColumnIndex = Get-LotColumnIndex -Headers $headers
    $lotColumnSource = "header"
    if ($lotColumnIndex -lt 0) {
      $lotColumnIndex = Get-LotColumnIndexFallback -Rows $rows -SharedStrings $sharedStrings
      if ($lotColumnIndex -ge 0) {
        $lotColumnSource = "fallback_b_column"
      }
    }
    $inventoryDate = Get-InventoryDateFromHeaders -Headers $headers

    $sheetAccepted = 0
    $sheetSkipped = 0
    $sheetCaulkRouted = 0
    $sheetReasonCounts = @{}

    foreach ($row in ($rows | Where-Object { [int]$_.GetAttribute("r") -gt 1 })) {
      $rowNumber = [int]$row.GetAttribute("r")
      $valueMap = Get-RowValueMap -Row $row -SharedStrings $sharedStrings
      $rawDescription = ""
      if ($valueMap.ContainsKey(0)) {
        $rawDescription = [string]$valueMap[0]
      }

      $rawQty = ""
      if ($quantityColumnIndex -ge 0 -and $valueMap.ContainsKey($quantityColumnIndex)) {
        $rawQty = [string]$valueMap[$quantityColumnIndex]
      }

      $rawLot = ""
      if ($lotColumnIndex -ge 0 -and $valueMap.ContainsKey($lotColumnIndex)) {
        $rawLot = [string]$valueMap[$lotColumnIndex]
      }

      if ([string]::IsNullOrWhiteSpace($rawDescription) -and [string]::IsNullOrWhiteSpace($rawQty)) {
        continue
      }

      if ([string]::IsNullOrWhiteSpace($inventoryDate)) {
        $reason = "missing_inventory_date"
        $exceptionsRows.Add((New-ExceptionRow -Sheet $sheetName -RowNumber $rowNumber -Reason $reason -RawDescription $rawDescription -RawQty $rawQty -RawLot $rawLot -ParsedIdCandidate "" -ParsedWidthCandidate "" -InventoryDate ""))
        $sheetSkipped++
        if (-not $sheetReasonCounts.ContainsKey($reason)) { $sheetReasonCounts[$reason] = 0 }
        $sheetReasonCounts[$reason]++
        if (-not $globalReasonCounts.ContainsKey($reason)) { $globalReasonCounts[$reason] = 0 }
        $globalReasonCounts[$reason]++
        continue
      }

      $parsed = Parse-Description `
        -RawDescription $rawDescription `
        -DefaultPrefix $defaultPrefix `
        -LegacyMPrefix $legacyMPrefix `
        -AllowOptionalHyphenDescriptions $allowOptionalHyphen
      if (-not $parsed.Success) {
        $reason = $parsed.Reason
        $exceptionsRows.Add((New-ExceptionRow -Sheet $sheetName -RowNumber $rowNumber -Reason $reason -RawDescription $rawDescription -RawQty $rawQty -RawLot $rawLot -ParsedIdCandidate $parsed.IdToken -ParsedWidthCandidate "" -InventoryDate $inventoryDate))
        $sheetSkipped++
        if (-not $sheetReasonCounts.ContainsKey($reason)) { $sheetReasonCounts[$reason] = 0 }
        $sheetReasonCounts[$reason]++
        if (-not $globalReasonCounts.ContainsKey($reason)) { $globalReasonCounts[$reason] = 0 }
        $globalReasonCounts[$reason]++
        continue
      }

      $quantityValue = Parse-Quantity -RawValue $rawQty
      if ($null -eq $quantityValue) {
        $reason = "missing_quantity"
        $exceptionsRows.Add((New-ExceptionRow -Sheet $sheetName -RowNumber $rowNumber -Reason $reason -RawDescription $rawDescription -RawQty $rawQty -RawLot $rawLot -ParsedIdCandidate $parsed.IdToken -ParsedWidthCandidate ([string]$parsed.WidthIn) -InventoryDate $inventoryDate))
        $sheetSkipped++
        if (-not $sheetReasonCounts.ContainsKey($reason)) { $sheetReasonCounts[$reason] = 0 }
        $sheetReasonCounts[$reason]++
        if (-not $globalReasonCounts.ContainsKey($reason)) { $globalReasonCounts[$reason] = 0 }
        $globalReasonCounts[$reason]++
        continue
      }

      if ($quantityValue -le 0) {
        $reason = "non_positive_quantity"
        $exceptionsRows.Add((New-ExceptionRow -Sheet $sheetName -RowNumber $rowNumber -Reason $reason -RawDescription $rawDescription -RawQty $rawQty -RawLot $rawLot -ParsedIdCandidate $parsed.IdToken -ParsedWidthCandidate ([string]$parsed.WidthIn) -InventoryDate $inventoryDate))
        $sheetSkipped++
        if (-not $sheetReasonCounts.ContainsKey($reason)) { $sheetReasonCounts[$reason] = 0 }
        $sheetReasonCounts[$reason]++
        if (-not $globalReasonCounts.ContainsKey($reason)) { $globalReasonCounts[$reason] = 0 }
        $globalReasonCounts[$reason]++
        continue
      }

      $quantityRounded = [math]::Round($quantityValue)
      $fractionalDelta = [math]::Abs($quantityValue - $quantityRounded)
      if ($fractionalDelta -gt 0.000001) {
        $reason = "fractional_quantity_not_supported"
        $exceptionsRows.Add((New-ExceptionRow -Sheet $sheetName -RowNumber $rowNumber -Reason $reason -RawDescription $rawDescription -RawQty $rawQty -RawLot $rawLot -ParsedIdCandidate $parsed.IdToken -ParsedWidthCandidate ([string]$parsed.WidthIn) -InventoryDate $inventoryDate))
        $sheetSkipped++
        if (-not $sheetReasonCounts.ContainsKey($reason)) { $sheetReasonCounts[$reason] = 0 }
        $sheetReasonCounts[$reason]++
        if (-not $globalReasonCounts.ContainsKey($reason)) { $globalReasonCounts[$reason] = 0 }
        $globalReasonCounts[$reason]++
        continue
      }

      $feet = [int]$quantityRounded
      $candidateBoxId = [string]$parsed.CandidateBoxId
      $manufacturer = Resolve-ManufacturerName -SheetName $sheetName -ManufacturerMap $manufacturerMap
      $lotRun = "$rawLot".Trim()
      $caulkSuggestion = Get-CaulkSuggestion -Manufacturer $manufacturer -FilmName $parsed.FilmName -RawDescription $rawDescription
      if ($caulkSuggestion.IsCaulkLike) {
        $caulkCandidateRows.Add((New-CaulkCandidateRow `
              -Sheet $sheetName `
              -RowNumber $rowNumber `
              -InventoryDate $inventoryDate `
              -BoxIdCandidate $candidateBoxId `
              -Manufacturer $manufacturer `
              -FilmName $parsed.FilmName `
              -WidthIn $parsed.WidthIn `
              -QuantityCases $feet `
              -LotRun $lotRun `
              -RawDescription $rawDescription `
              -DetectionReason $caulkSuggestion.DetectionReason `
              -SuggestedManufacturer $caulkSuggestion.SuggestedManufacturer `
              -SuggestedProductName $caulkSuggestion.SuggestedProductName `
              -SuggestedProductCode $caulkSuggestion.SuggestedProductCode `
              -SuggestedTubesPerCase $caulkSuggestion.SuggestedTubesPerCase))
        $sheetCaulkRouted++
        if (-not $caulkReasonCounts.ContainsKey($caulkSuggestion.DetectionReason)) {
          $caulkReasonCounts[$caulkSuggestion.DetectionReason] = 0
        }
        $caulkReasonCounts[$caulkSuggestion.DetectionReason]++
        continue
      }

      if ($seenBoxIds.ContainsKey($candidateBoxId)) {
        $first = $seenBoxIds[$candidateBoxId]
        $collisionsRows.Add([pscustomobject][ordered]@{
            box_id = $candidateBoxId
            first_sheet = $first.sheet
            first_row_number = $first.row_number
            first_raw_description = $first.raw_description
            duplicate_sheet = $sheetName
            duplicate_row_number = $rowNumber
            duplicate_raw_description = $rawDescription
          })

        $reason = "duplicate_box_id"
        $exceptionsRows.Add((New-ExceptionRow -Sheet $sheetName -RowNumber $rowNumber -Reason $reason -RawDescription $rawDescription -RawQty $rawQty -RawLot $rawLot -ParsedIdCandidate $parsed.IdToken -ParsedWidthCandidate ([string]$parsed.WidthIn) -InventoryDate $inventoryDate))
        $sheetSkipped++
        if (-not $sheetReasonCounts.ContainsKey($reason)) { $sheetReasonCounts[$reason] = 0 }
        $sheetReasonCounts[$reason]++
        if (-not $globalReasonCounts.ContainsKey($reason)) { $globalReasonCounts[$reason] = 0 }
        $globalReasonCounts[$reason]++
        continue
      }

      $seenBoxIds[$candidateBoxId] = [pscustomobject]@{
        sheet = $sheetName
        row_number = $rowNumber
        raw_description = $rawDescription
      }

      $boxesRow = New-BoxesRawRow -BoxId $candidateBoxId -Manufacturer $manufacturer -FilmName $parsed.FilmName -WidthIn $parsed.WidthIn -Feet $feet -LotRun $lotRun -InventoryDate $inventoryDate -SourceSheet $sheetName -SourceRow $rowNumber -RawDescription $rawDescription
      $boxesRows.Add($boxesRow)

      $warehouseBucket = Get-WarehouseBucketFromBoxId -BoxId $candidateBoxId
      if (-not $warehouseCounts.ContainsKey($warehouseBucket)) {
        $warehouseCounts[$warehouseBucket] = 0
      }
      $warehouseCounts[$warehouseBucket] = [int]$warehouseCounts[$warehouseBucket] + 1

      $sheetAccepted++
    }

    $perSheetSummary.Add([pscustomobject]@{
        sheet = $sheetName
        inventory_date = $inventoryDate
        quantity_column = if ($quantityColumnIndex -ge 0 -and $quantityColumnIndex -lt $headers.Count) { $headers[$quantityColumnIndex] } else { $null }
        lot_column = if ($lotColumnIndex -ge 0 -and $lotColumnIndex -lt $headers.Count) { $headers[$lotColumnIndex] } else { $null }
        lot_column_source = $lotColumnSource
        accepted_rows = $sheetAccepted
        skipped_rows = $sheetSkipped
        caulk_routed_rows = $sheetCaulkRouted
        reasons = $sheetReasonCounts
      })
  }

  # Validation checks before write.
  $boxIds = @($boxesRows | ForEach-Object { $_.BoxID })
  $duplicateOutputIds = @($boxIds | Group-Object | Where-Object { $_.Count -gt 1 })
  if ($duplicateOutputIds.Count -gt 0) {
    throw "Validation failed: duplicate BoxID values remained in boxes_raw output."
  }

  $invalidFeetRow = $boxesRows | Where-Object {
    ($_.InitialFeet -as [int]) -le 0 -or ($_.FeetAvailable -as [int]) -le 0
  } | Select-Object -First 1
  if ($invalidFeetRow) {
    throw "Validation failed: non-positive feet value detected in boxes_raw output."
  }

  $invalidDateRow = $boxesRows | Where-Object {
    ($_.OrderDate -notmatch "^\d{4}-\d{2}-\d{2}$") -or ($_.ReceivedDate -notmatch "^\d{4}-\d{2}-\d{2}$")
  } | Select-Object -First 1
  if ($invalidDateRow) {
    throw "Validation failed: invalid date format detected in boxes_raw output."
  }

  $invalidBoxIdRow = $boxesRows | Where-Object {
    "$($_.BoxID)" -notmatch "^[A-Z]{2}[1-9][0-9]*-[A-Z0-9]+$"
  } | Select-Object -First 1
  if ($invalidBoxIdRow) {
    throw "Validation failed: non-canonical BoxID format detected in boxes_raw output."
  }

  $boxesRows | Select-Object $boxesRawColumns | Export-Csv -LiteralPath $boxesCsvPath -NoTypeInformation -Encoding UTF8
  $exceptionsRows | Export-Csv -LiteralPath $exceptionsCsvPath -NoTypeInformation -Encoding UTF8
  $collisionsRows | Export-Csv -LiteralPath $collisionsCsvPath -NoTypeInformation -Encoding UTF8
  $caulkCandidateRows | Export-Csv -LiteralPath $caulkCandidatesCsvPath -NoTypeInformation -Encoding UTF8

  $candidateByKey = @{}
  foreach ($candidate in $caulkCandidateRows) {
    $candidateKey = Get-CaulkCandidateKey -Sheet ([string]$candidate.source_sheet) -RowNumber ([int]$candidate.row_number) -BoxIdCandidate ([string]$candidate.box_id_candidate)
    $candidateByKey[$candidateKey] = $candidate
  }

  $existingReviewByKey = @{}
  if (Test-Path -LiteralPath $caulkReviewCsvPath) {
    $existingReviews = Import-Csv -LiteralPath $caulkReviewCsvPath
    foreach ($review in $existingReviews) {
      $reviewRowNumber = 0
      [void][int]::TryParse([string]$review.row_number, [ref]$reviewRowNumber)
      $reviewKey = Get-CaulkCandidateKey -Sheet ([string]$review.source_sheet) -RowNumber $reviewRowNumber -BoxIdCandidate ([string]$review.box_id_candidate)
      $existingReviewByKey[$reviewKey] = $review
    }
  }

  $reviewRows = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in $caulkCandidateRows) {
    $candidateKey = Get-CaulkCandidateKey -Sheet ([string]$candidate.source_sheet) -RowNumber ([int]$candidate.row_number) -BoxIdCandidate ([string]$candidate.box_id_candidate)
    $existingRow = $null
    if ($existingReviewByKey.ContainsKey($candidateKey)) {
      $existingRow = $existingReviewByKey[$candidateKey]
    }
    $reviewRows.Add((New-CaulkReviewRow -Candidate $candidate -Existing $existingRow))
  }
  $reviewRows | Export-Csv -LiteralPath $caulkReviewCsvPath -NoTypeInformation -Encoding UTF8

  $caulkFinalRows = New-Object System.Collections.Generic.List[object]
  $approvedCount = 0
  $rejectedCount = 0
  $pendingCount = 0
  foreach ($review in $reviewRows) {
    $decision = ([string]$review.decision).Trim().ToLowerInvariant()
    $isApproved = $decision -in @("approve", "approved", "yes", "y", "true", "1")
    $isRejected = $decision -in @("reject", "rejected", "no", "n", "false", "0")

    if ($isRejected) {
      $rejectedCount++
      continue
    }

    if (-not $isApproved) {
      $pendingCount++
      continue
    }

    $approvedCount++
    $reviewRowNumber = [int]$review.row_number
    $reviewKey = Get-CaulkCandidateKey -Sheet ([string]$review.source_sheet) -RowNumber $reviewRowNumber -BoxIdCandidate ([string]$review.box_id_candidate)
    if (-not $candidateByKey.ContainsKey($reviewKey)) {
      continue
    }

    $candidate = $candidateByKey[$reviewKey]
    $canonicalManufacturer = ([string]$review.canonical_manufacturer).Trim()
    if ([string]::IsNullOrWhiteSpace($canonicalManufacturer)) {
      $canonicalManufacturer = [string]$candidate.suggested_manufacturer
    }
    $canonicalProductName = ([string]$review.canonical_product_name).Trim()
    if ([string]::IsNullOrWhiteSpace($canonicalProductName)) {
      $canonicalProductName = [string]$candidate.suggested_product_name
    }
    $canonicalProductCode = ([string]$review.canonical_product_code).Trim()
    if ([string]::IsNullOrWhiteSpace($canonicalProductCode)) {
      $canonicalProductCode = [string]$candidate.suggested_product_code
    }

    $canonicalTubesPerCase = 16
    [void][int]::TryParse([string]$review.canonical_tubes_per_case, [ref]$canonicalTubesPerCase)
    if ($canonicalTubesPerCase -le 0) {
      $canonicalTubesPerCase = 16
    }

    $caulkFinalRows.Add([pscustomobject][ordered]@{
        source_sheet = [string]$candidate.source_sheet
        row_number = [int]$candidate.row_number
        box_id_candidate = [string]$candidate.box_id_candidate
        warehouse = [string]$candidate.warehouse_candidate
        manufacturer = $canonicalManufacturer
        product_name = $canonicalProductName
        product_code = $canonicalProductCode
        tubes_per_case = $canonicalTubesPerCase
        quantity_cases = [int]$candidate.quantity_cases
        quantity_tubes = ([int]$candidate.quantity_cases * $canonicalTubesPerCase)
        inventory_date = [string]$candidate.inventory_date
        lot_run = [string]$candidate.lot_run
        raw_description = [string]$candidate.raw_description
      })
  }

  $caulkFinalRows | Export-Csv -LiteralPath $caulkFinalCsvPath -NoTypeInformation -Encoding UTF8

  $acceptedCount = $boxesRows.Count
  $skippedCount = $exceptionsRows.Count
  $collisionCount = $collisionsRows.Count
  $caulkCandidateCount = $caulkCandidateRows.Count

  $summary = [pscustomobject][ordered]@{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    profile = $Profile
    allow_optional_hyphen_descriptions = $allowOptionalHyphen
    default_prefix = $defaultPrefix
    legacy_m_prefix = $legacyMPrefix
    workbook_path = $WorkbookPath
    output_dir = $outputPath
    totals = [pscustomobject][ordered]@{
      accepted_rows = $acceptedCount
      skipped_rows = $skippedCount
      collision_rows = $collisionCount
      caulk_candidate_rows = $caulkCandidateCount
    }
    warehouse_counts = [pscustomobject][ordered]@{
      IL = [int]$warehouseCounts["IL"]
      MS = [int]$warehouseCounts["MS"]
      OTHER = [int]$warehouseCounts["OTHER"]
    }
    target_sheets = $targetSheetNames
    per_sheet = $perSheetSummary
    skip_reasons = [pscustomobject]$globalReasonCounts
    caulk_reasons = [pscustomobject]$caulkReasonCounts
    baseline_reference = [pscustomobject][ordered]@{
      expected_accepted_approx = $config.baseline_accepted
      expected_skipped_approx = $config.baseline_skipped
    }
    critical_success_gates = [pscustomobject][ordered]@{
      use_test_or_new_org = $true
      run_import_clear_staging_before_each_attempt = $true
      review_collision_and_exception_files_before_live_load = $true
      ensure_boxes_raw_header_matches_import_table = $true
      post_load_verify_counts_duplicates_required_fields_and_warehouse_split = $true
    }
  }

  $caulkSummary = [pscustomobject][ordered]@{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    profile = $Profile
    workbook_path = $WorkbookPath
    output_dir = $outputPath
    totals = [pscustomobject][ordered]@{
      candidate_rows = $caulkCandidateCount
      approved_rows = $approvedCount
      rejected_rows = $rejectedCount
      pending_rows = $pendingCount
      final_rows = $caulkFinalRows.Count
    }
    detection_reasons = [pscustomobject]$caulkReasonCounts
    notes = @(
      "Review caulk_review_decisions.csv and set decision=approve/reject for every candidate row.",
      "Only approved rows are emitted into caulk_raw_final.csv."
    )
  }

  $summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $summaryJsonPath -Encoding UTF8
  $caulkSummary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $caulkSummaryJsonPath -Encoding UTF8

  Write-Host "Dry-run transform complete."
  Write-Host "Profile:       $Profile"
  Write-Host "Accepted rows: $acceptedCount"
  Write-Host "Skipped rows:  $skippedCount"
  Write-Host "Collisions:    $collisionCount"
  Write-Host "Caulk rows:    $caulkCandidateCount"
  Write-Host "Artifacts:"
  Write-Host "  $boxesCsvPath"
  Write-Host "  $exceptionsCsvPath"
  Write-Host "  $collisionsCsvPath"
  Write-Host "  $summaryJsonPath"
  Write-Host "  $caulkCandidatesCsvPath"
  Write-Host "  $caulkReviewCsvPath"
  Write-Host "  $caulkFinalCsvPath"
  Write-Host "  $caulkSummaryJsonPath"
} finally {
  $archive.Dispose()
}
