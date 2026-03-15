param(
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$RunDir = "",
  [string]$DefaultPrefix = "",
  [string]$LegacyMPrefix = "",
  [string]$ResolvedCsvPath = "",
  [string]$RemainingExceptionsCsvPath = "",
  [string]$ManualResolutionLogPath = "",
  [string]$SummaryJsonPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$profileConfigs = @{
  IL = [pscustomobject]@{
    run_dir = "backend/migration-dry-runs/il-assigned"
    default_prefix = "IL1"
    legacy_m_prefix = "MS1"
    manufacturer_map = @{
      "SOLAR GUARD" = "Solar Gard"
    }
  }
  MS = [pscustomobject]@{
    run_dir = "backend/migration-dry-runs/ms-inventory"
    default_prefix = "MS1"
    legacy_m_prefix = "MS1"
    manufacturer_map = @{
      "SOLAR GUARD" = "Solar Gard"
      "LLUMARVISTA" = "Llumar"
      "MADICO" = "ASWFVKOOL"
    }
  }
}

$config = $profileConfigs[$Profile]
if ($null -eq $config) {
  throw "Unsupported profile: $Profile"
}
if ([string]::IsNullOrWhiteSpace($RunDir)) {
  $RunDir = [string]$config.run_dir
}
if ([string]::IsNullOrWhiteSpace($DefaultPrefix)) {
  $DefaultPrefix = [string]$config.default_prefix
}
if ([string]::IsNullOrWhiteSpace($LegacyMPrefix)) {
  $LegacyMPrefix = [string]$config.legacy_m_prefix
}

if ([string]::IsNullOrWhiteSpace($ResolvedCsvPath)) {
  $ResolvedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_resolved_with_widths.csv"
}
if ([string]::IsNullOrWhiteSpace($RemainingExceptionsCsvPath)) {
  $RemainingExceptionsCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_exceptions_remaining.csv"
}
if ([string]::IsNullOrWhiteSpace($ManualResolutionLogPath)) {
  $ManualResolutionLogPath = Join-Path -Path $RunDir -ChildPath "exception_manual_resolutions.csv"
}
if ([string]::IsNullOrWhiteSpace($SummaryJsonPath)) {
  $SummaryJsonPath = Join-Path -Path $RunDir -ChildPath "missing_quantity_zeroed_summary.json"
}

if (-not (Test-Path -LiteralPath $ResolvedCsvPath)) {
  throw "Resolved CSV not found: $ResolvedCsvPath"
}
if (-not (Test-Path -LiteralPath $RemainingExceptionsCsvPath)) {
  throw "Remaining exceptions CSV not found: $RemainingExceptionsCsvPath"
}

function Parse-IdToken {
  param([string]$Description)
  $text = "$Description".Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return ""
  }

  $match = [regex]::Match($text, "^(?<id>[A-Za-z]{2}[1-9][0-9]*-[A-Za-z0-9]+)\s*-\s*")
  if (-not $match.Success) {
    $match = [regex]::Match($text, "^(?<id>[A-Za-z0-9]{2,16})\s*-\s*")
  }
  if (-not $match.Success) {
    $match = [regex]::Match($text, "^(?<id>[A-Za-z0-9]{2,16})\s+")
  }

  if ($match.Success) {
    return $match.Groups["id"].Value.ToUpperInvariant()
  }
  return ""
}

function Normalize-TrailingLetterSuffix {
  param([string]$BoxId)

  if ([string]::IsNullOrWhiteSpace($BoxId)) {
    return ""
  }

  $clean = $BoxId.Trim().ToUpperInvariant()
  $match = [regex]::Match($clean, "^(?<prefix>[A-Z]{2}[1-9][0-9]*)-(?<number>\d+)[A-Z]$")
  if ($match.Success) {
    return "$($match.Groups["prefix"].Value)-$($match.Groups["number"].Value)"
  }

  return $clean
}

function Normalize-CanonicalBoxId {
  param([string]$RawBoxId)

  if ([string]::IsNullOrWhiteSpace($RawBoxId)) {
    return ""
  }

  $clean = $RawBoxId.Trim().ToUpperInvariant()
  if ($clean -match "^(?<state>[A-Z]{2})-(?<suffix>[A-Z0-9]+)$") {
    $clean = "$($matches["state"])1-$($matches["suffix"])"
  }

  return Normalize-TrailingLetterSuffix -BoxId $clean
}

function Build-BoxId {
  param(
    [string]$IdToken,
    [string]$DefaultPrefix,
    [string]$LegacyMPrefix
  )

  if ([string]::IsNullOrWhiteSpace($IdToken)) {
    return ""
  }

  $token = $IdToken.Trim().ToUpperInvariant()
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

function Infer-WidthFromDescription {
  param([string]$Description)
  $match = [regex]::Match("$Description", '(?<w>\d{2,3})\s*"')
  if ($match.Success) {
    return [int]$match.Groups["w"].Value
  }
  return $null
}

function Normalize-Width {
  param(
    [string]$ParsedWidthCandidate,
    [string]$Description
  )

  $quoted = Infer-WidthFromDescription -Description $Description
  if ($null -ne $quoted -and $quoted -gt 0) {
    return [pscustomobject]@{
      Width = $quoted
      Source = "quoted_hint"
    }
  }

  $candidate = 0
  if ([int]::TryParse("$ParsedWidthCandidate", [ref]$candidate)) {
    # Guard against product-code false positives like F473.
    if ($candidate -ge 12 -and $candidate -le 96) {
      return [pscustomobject]@{
        Width = $candidate
        Source = "parsed_candidate"
      }
    }
  }

  return [pscustomobject]@{
    Width = 60
    Source = "default_60"
  }
}

function Build-FilmName {
  param(
    [string]$Description,
    [int]$Width
  )

  $descriptionText = "$Description".Trim()
  $match = [regex]::Match($descriptionText, "^[A-Za-z]{2}[1-9][0-9]*-[A-Za-z0-9]+\s*-\s*(?<rest>.+)$")
  if (-not $match.Success) {
    $match = [regex]::Match($descriptionText, "^[A-Za-z0-9]{2,16}\s*-\s*(?<rest>.+)$")
  }
  if (-not $match.Success) {
    $match = [regex]::Match($descriptionText, "^[A-Za-z0-9]{2,16}\s+(?<rest>.+)$")
  }
  if (-not $match.Success) {
    return [regex]::Replace("$Description".Trim(), "\s+", " ")
  }

  $rest = [regex]::Replace($match.Groups["rest"].Value.Trim(), "\s+", " ")
  $patternQuoted = "(?i)\b" + [regex]::Escape([string]$Width) + '\s*"'
  $withoutWidth = [regex]::Replace($rest, $patternQuoted, "", 1)

  if ($withoutWidth -eq $rest) {
    $patternPlain = "(?i)\b" + [regex]::Escape([string]$Width) + "\b"
    $withoutWidth = [regex]::Replace($rest, $patternPlain, "", 1)
  }

  $withoutWidth = [regex]::Replace($withoutWidth, "\s+", " ").Trim(" ", "-", ",")
  return $withoutWidth
}

function Test-DateYmd {
  param([string]$Value)
  return "$Value" -match "^\d{4}-\d{2}-\d{2}$"
}

$resolvedRows = Import-Csv -LiteralPath $ResolvedCsvPath
$remainingExceptions = Import-Csv -LiteralPath $RemainingExceptionsCsvPath
$missingQuantityRows = @($remainingExceptions | Where-Object { $_.reason -eq "missing_quantity" })

if ($missingQuantityRows.Count -eq 0) {
  Write-Host "No missing_quantity rows found."
  exit 0
}

$rowsById = @{}
foreach ($row in $resolvedRows) {
  $rowsById[$row.BoxID] = $row
}

$inserted = 0
$updated = 0
$skipped = 0
$conflicts = New-Object System.Collections.Generic.List[object]
$applied = New-Object System.Collections.Generic.List[object]

foreach ($exception in $missingQuantityRows) {
  $idToken = Parse-IdToken -Description $exception.raw_description
  $boxId = Build-BoxId -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
  if ([string]::IsNullOrWhiteSpace($boxId)) {
    $skipped++
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "id_parse_failed"
        raw_description = $exception.raw_description
      })
    continue
  }

  $widthInfo = Normalize-Width -ParsedWidthCandidate $exception.parsed_width_candidate -Description $exception.raw_description
  $width = [int]$widthInfo.Width
  $widthSource = [string]$widthInfo.Source

  $manufacturer = Resolve-ManufacturerName -SheetName "$($exception.sheet)" -ManufacturerMap $config.manufacturer_map
  $filmName = Build-FilmName -Description $exception.raw_description -Width $width
  if ([string]::IsNullOrWhiteSpace($filmName)) {
    $skipped++
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "film_name_parse_failed"
        raw_description = $exception.raw_description
      })
    continue
  }

  $inventoryDate = "$($exception.inventory_date)".Trim()
  if (-not (Test-DateYmd -Value $inventoryDate)) {
    $skipped++
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "invalid_inventory_date"
        inventory_date = $inventoryDate
      })
    continue
  }

  $lotRun = "$($exception.raw_lot)".Trim()
  $filmKey = "$($manufacturer.ToUpperInvariant())|$($filmName.ToUpperInvariant())"
  $notes = "ExceptionResolved=missing_quantity_to_zeroed; SourceSheet=$($exception.sheet); SourceRow=$($exception.row_number); WidthSource=$widthSource; RawDescription=$($exception.raw_description)"

  $newRow = [pscustomobject][ordered]@{
    BoxID = $boxId
    Manufacturer = $manufacturer
    FilmName = $filmName
    WidthIn = "$width"
    InitialFeet = "0"
    FeetAvailable = "0"
    LotRun = $lotRun
    Status = "ZEROED"
    OrderDate = $inventoryDate
    ReceivedDate = $inventoryDate
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
    ZeroedDate = $inventoryDate
    ZeroedReason = "Missing quantity in source workbook"
    ZeroedBy = "migration"
  }

  if ($rowsById.ContainsKey($boxId)) {
    $rowsById[$boxId] = $newRow
    $updated++
  } else {
    $rowsById[$boxId] = $newRow
    $inserted++
  }

  $applied.Add([pscustomobject]@{
      box_id = $boxId
      sheet = $exception.sheet
      row_number = $exception.row_number
      action = "zeroed"
      width = $width
      width_source = $widthSource
      lot_run = $lotRun
      order_date = $inventoryDate
    })
}

$finalRows = @($rowsById.Values | Sort-Object BoxID)

$duplicateIds = @($finalRows | Group-Object BoxID | Where-Object { $_.Count -gt 1 })
if ($duplicateIds.Count -gt 0) {
  throw "Validation failed: duplicate BoxID values exist after missing_quantity zeroed resolution."
}

$invalidRows = @(
  $finalRows | Where-Object {
    [string]::IsNullOrWhiteSpace($_.BoxID) -or
    [string]::IsNullOrWhiteSpace($_.Manufacturer) -or
    [string]::IsNullOrWhiteSpace($_.FilmName) -or
    ([double]$_.WidthIn) -le 0 -or
    ([int]$_.InitialFeet) -lt 0 -or
    ([int]$_.FeetAvailable) -lt 0 -or
    ([int]$_.FeetAvailable) -gt ([int]$_.InitialFeet) -or
    -not (Test-DateYmd -Value $_.OrderDate) -or
    -not (Test-DateYmd -Value $_.ReceivedDate)
  }
)
if ($invalidRows.Count -gt 0) {
  throw "Validation failed: invalid row(s) exist after missing_quantity zeroed resolution."
}

$remainingAfter = @($remainingExceptions | Where-Object { $_.reason -ne "missing_quantity" })

$finalRows | Export-Csv -LiteralPath $ResolvedCsvPath -NoTypeInformation -Encoding UTF8
$remainingAfter | Export-Csv -LiteralPath $RemainingExceptionsCsvPath -NoTypeInformation -Encoding UTF8

if (-not (Test-Path -LiteralPath $ManualResolutionLogPath)) {
  "sheet,row_number,reason,action,box_id,manufacturer,film_name,width_in,initial_feet,lot_run,order_date,note" |
  Set-Content -LiteralPath $ManualResolutionLogPath -Encoding UTF8
}

foreach ($row in $applied) {
  $targetRow = $finalRows | Where-Object { $_.BoxID -eq $row.box_id } | Select-Object -First 1
  $line = "$($row.sheet),$($row.row_number),missing_quantity,zeroed_missing_quantity,$($row.box_id),$($targetRow.Manufacturer),$($targetRow.FilmName),$($targetRow.WidthIn),0,$($targetRow.LotRun),$($targetRow.OrderDate),width_source=$($row.width_source)"
  Add-Content -LiteralPath $ManualResolutionLogPath -Encoding UTF8 -Value $line
}

$summary = [pscustomobject][ordered]@{
  generated_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  profile = $Profile
  run_dir = $RunDir
  default_prefix = $DefaultPrefix
  legacy_m_prefix = $LegacyMPrefix
  source_files = [pscustomobject]@{
    resolved_csv = $ResolvedCsvPath
    remaining_exceptions_csv = $RemainingExceptionsCsvPath
    manual_resolution_log = $ManualResolutionLogPath
  }
  processed_missing_quantity_rows = $missingQuantityRows.Count
  inserted_rows = $inserted
  updated_rows = $updated
  skipped_rows = $skipped
  remaining_exceptions_count = $remainingAfter.Count
  remaining_exceptions_by_reason = @(
    $remainingAfter |
    Group-Object reason |
    Sort-Object Name |
    ForEach-Object {
      [pscustomobject]@{
        reason = $_.Name
        count = $_.Count
      }
    }
  )
  zeroed_added = $applied
  conflicts = $conflicts
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SummaryJsonPath -Encoding UTF8

Write-Host "Missing quantity rows processed as ZEROED."
Write-Host "Processed: $($missingQuantityRows.Count)"
Write-Host "Inserted:  $inserted"
Write-Host "Updated:   $updated"
Write-Host "Skipped:   $skipped"
Write-Host "Remaining exceptions: $($remainingAfter.Count)"
Write-Host "Summary: $SummaryJsonPath"
