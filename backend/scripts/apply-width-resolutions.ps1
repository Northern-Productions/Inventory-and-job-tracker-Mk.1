param(
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$RunDir = "",
  [string]$DefaultPrefix = "",
  [string]$LegacyMPrefix = "",
  [string]$ResolvedCsvPath = "",
  [string]$ExceptionsCsvPath = "",
  [string]$WidthResCsvPath = "",
  [string]$CollisionResCsvPath = "",
  [string]$OutputResolvedCsvPath = "",
  [string]$OutputRemainingExceptionsCsvPath = "",
  [string]$OutputSummaryJsonPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$profileConfigs = @{
  IL = [pscustomobject]@{
    run_dir = "backend/migration-dry-runs/il-assigned"
    default_prefix = "IL1"
    legacy_m_prefix = "MS1"
    manufacturer_map = @{
      "FASARA" = "3M Fasara"
      "SOLAR GUARD" = "Solar Gard"
    }
  }
  MS = [pscustomobject]@{
    run_dir = "backend/migration-dry-runs/ms-inventory"
    default_prefix = "MS1"
    legacy_m_prefix = "MS1"
    manufacturer_map = @{
      "FASARA" = "3M Fasara"
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
  $ResolvedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_resolved.csv"
}
if ([string]::IsNullOrWhiteSpace($ExceptionsCsvPath)) {
  $ExceptionsCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_exceptions.csv"
}
if ([string]::IsNullOrWhiteSpace($WidthResCsvPath)) {
  $WidthResCsvPath = Join-Path -Path $RunDir -ChildPath "exception_width_resolutions.csv"
}
if ([string]::IsNullOrWhiteSpace($CollisionResCsvPath)) {
  $CollisionResCsvPath = Join-Path -Path $RunDir -ChildPath "collision_resolutions.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputResolvedCsvPath)) {
  $OutputResolvedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_resolved_with_widths.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputRemainingExceptionsCsvPath)) {
  $OutputRemainingExceptionsCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_exceptions_remaining.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputSummaryJsonPath)) {
  $OutputSummaryJsonPath = Join-Path -Path $RunDir -ChildPath "width_resolution_summary.json"
}

$seedResolvedPath = Join-Path -Path (Split-Path -Path $ResolvedCsvPath -Parent) -ChildPath "boxes_raw.csv"
if (-not (Test-Path -LiteralPath $ResolvedCsvPath)) {
  if (Test-Path -LiteralPath $seedResolvedPath) {
    Copy-Item -LiteralPath $seedResolvedPath -Destination $ResolvedCsvPath -Force
  }
} elseif (Test-Path -LiteralPath $seedResolvedPath) {
  $seedInfo = Get-Item -LiteralPath $seedResolvedPath
  $resolvedInfo = Get-Item -LiteralPath $ResolvedCsvPath
  if ($seedInfo.LastWriteTimeUtc -gt $resolvedInfo.LastWriteTimeUtc) {
    Copy-Item -LiteralPath $seedResolvedPath -Destination $ResolvedCsvPath -Force
  }

  $resolvedPreview = @(Import-Csv -LiteralPath $ResolvedCsvPath | Select-Object -First 1)
  if ($resolvedPreview.Count -gt 0) {
    $resolvedColumns = @($resolvedPreview[0].PSObject.Properties.Name)
    if (-not ($resolvedColumns -contains "PricePerLf")) {
      Copy-Item -LiteralPath $seedResolvedPath -Destination $ResolvedCsvPath -Force
    }
  }
}

foreach ($requiredPath in @($ResolvedCsvPath, $ExceptionsCsvPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required file not found: $requiredPath"
  }
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

function Parse-PositiveFeet {
  param([string]$RawValue)
  $clean = "$RawValue".Trim().Replace(",", "").Replace("'", "")
  $clean = [regex]::Replace($clean, "[^0-9\.\-]", "")
  if ([string]::IsNullOrWhiteSpace($clean) -or $clean -eq "." -or $clean -eq "-") {
    return $null
  }

  $parsed = 0.0
  if (-not [double]::TryParse(
      $clean,
      [System.Globalization.NumberStyles]::Float,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsed
    )) {
    return $null
  }

  if ($parsed -le 0) {
    return $null
  }

  $rounded = [math]::Round($parsed)
  if ([math]::Abs($parsed - $rounded) -gt 0.000001) {
    return $null
  }

  return [int]$rounded
}

function Infer-WidthHint {
  param([string]$Description)
  $match = [regex]::Match("$Description", '(?<w>\d{2,3})\s*"')
  if ($match.Success) {
    return [int]$match.Groups["w"].Value
  }
  return $null
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

$rows = Import-Csv -LiteralPath $ResolvedCsvPath
$requiredResolvedColumns = @(
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
  "PricePerLf",
  "PurchaseCost",
  "Notes",
  "HasEverBeenCheckedOut",
  "LastCheckoutJob",
  "LastCheckoutDate",
  "ZeroedDate",
  "ZeroedReason",
  "ZeroedBy"
)
if ($rows.Count -gt 0) {
  $resolvedHeader = @($rows[0].PSObject.Properties.Name)
  foreach ($col in $requiredResolvedColumns) {
    if (-not ($resolvedHeader -contains $col)) {
      throw "Resolved CSV missing required column: $col"
    }
  }
}
$exceptions = Import-Csv -LiteralPath $ExceptionsCsvPath
$missingWidthExceptions = @($exceptions | Where-Object { $_.reason -eq "missing_width" })

$widthResExisting = @()
if (Test-Path -LiteralPath $WidthResCsvPath) {
  $widthResExisting = Import-Csv -LiteralPath $WidthResCsvPath
}

$collisionResolutions = @()
if (Test-Path -LiteralPath $CollisionResCsvPath) {
  $collisionResolutions = Import-Csv -LiteralPath $CollisionResCsvPath
}

$widthResolutionKeySet = @{}
foreach ($resolution in $widthResExisting) {
  $key = "$($resolution.sheet)|$($resolution.row_number)|$($resolution.reason)"
  $widthResolutionKeySet[$key] = $true
}

$newWidthResolutions = New-Object System.Collections.Generic.List[object]

foreach ($exception in $missingWidthExceptions) {
  $key = "$($exception.sheet)|$($exception.row_number)|$($exception.reason)"
  if ($widthResolutionKeySet.ContainsKey($key)) {
    continue
  }

  $hint = Infer-WidthHint -Description $exception.raw_description
  $width = if ($null -ne $hint) { $hint } else { 60 }
  $note = if ($null -ne $hint) { "auto_from_description_hint_user_approved" } else { "auto_default_60_user_approved" }

  $idToken = Parse-IdToken -Description $exception.raw_description
  $boxId = Build-BoxId -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix

  $newWidthResolutions.Add([pscustomobject][ordered]@{
      box_id = $boxId
      sheet = $exception.sheet
      row_number = $exception.row_number
      reason = $exception.reason
      resolution = "set_width"
      width_in = "$width"
      note = $note
    })
}

$allWidthResolutions = @($widthResExisting + $newWidthResolutions)
$allWidthResolutions |
Sort-Object sheet, @{ Expression = { [int]$_.row_number } } |
Export-Csv -LiteralPath $WidthResCsvPath -NoTypeInformation -Encoding UTF8

$rowsById = @{}
$canonicalizedInputBoxIds = 0
$canonicalizedInputCollisions = New-Object System.Collections.Generic.List[object]
foreach ($row in $rows) {
  $rawBoxId = "$($row.BoxID)".Trim().ToUpperInvariant()
  $canonicalBoxId = Normalize-CanonicalBoxId -RawBoxId $rawBoxId
  if ($canonicalBoxId -notmatch "^[A-Z]{2}[1-9][0-9]*-[A-Z0-9]+$" -and $rawBoxId -match "^[A-Z0-9]{1,24}$") {
    $rebuiltBoxId = Build-BoxId -IdToken $rawBoxId -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
    if (-not [string]::IsNullOrWhiteSpace($rebuiltBoxId)) {
      $canonicalBoxId = $rebuiltBoxId
    }
  }
  if ([string]::IsNullOrWhiteSpace($canonicalBoxId)) {
    $canonicalBoxId = $rawBoxId
  }

  if ($canonicalBoxId -ne $rawBoxId) {
    $canonicalizedInputBoxIds++
    if ($rowsById.ContainsKey($canonicalBoxId)) {
      $canonicalizedInputCollisions.Add([pscustomobject]@{
          canonical_box_id = $canonicalBoxId
          replaced_raw_box_id = $rawBoxId
          existing_box_id = "$($rowsById[$canonicalBoxId].BoxID)"
        })
    }
  }

  $row.BoxID = $canonicalBoxId
  $rowsById[$canonicalBoxId] = $row
}

$insertedCount = 0
$updatedCount = 0
$conflicts = New-Object System.Collections.Generic.List[object]

foreach ($resolution in $allWidthResolutions) {
  $exception = $missingWidthExceptions | Where-Object {
    $_.sheet -eq $resolution.sheet -and $_.row_number -eq $resolution.row_number
  } | Select-Object -First 1

  if (-not $exception) {
    continue
  }

  $idToken = Parse-IdToken -Description $exception.raw_description
  $boxId = Build-BoxId -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
  if ([string]::IsNullOrWhiteSpace($boxId)) {
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "id_parse_failed"
        raw_description = $exception.raw_description
      })
    continue
  }

  $feet = Parse-PositiveFeet -RawValue $exception.raw_qty
  if ($null -eq $feet) {
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "qty_parse_failed"
        raw_qty = $exception.raw_qty
      })
    continue
  }

  $width = [int]$resolution.width_in
  if ($width -le 0) {
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "invalid_width_resolution"
        width_in = $resolution.width_in
      })
    continue
  }

  $manufacturer = Resolve-ManufacturerName -SheetName "$($exception.sheet)" -ManufacturerMap $config.manufacturer_map
  $filmName = Build-FilmName -Description $exception.raw_description -Width $width
  if ([string]::IsNullOrWhiteSpace($filmName)) {
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "film_name_parse_failed"
        raw_description = $exception.raw_description
      })
    continue
  }

  $filmKey = "$($manufacturer.ToUpperInvariant())|$($filmName.ToUpperInvariant())"
  $lotRun = "$($exception.raw_lot)".Trim()
  $inventoryDate = "$($exception.inventory_date)".Trim()
  if ($inventoryDate -notmatch "^\d{4}-\d{2}-\d{2}$") {
    $conflicts.Add([pscustomobject]@{
        sheet = $exception.sheet
        row_number = $exception.row_number
        reason = "invalid_inventory_date"
        inventory_date = $inventoryDate
      })
    continue
  }

  $newRow = [pscustomobject][ordered]@{
    BoxID = $boxId
    Manufacturer = $manufacturer
    FilmName = $filmName
    WidthIn = "$width"
    InitialFeet = "$feet"
    FeetAvailable = "$feet"
    LotRun = $lotRun
    Status = "IN_STOCK"
    OrderDate = $inventoryDate
    ReceivedDate = $inventoryDate
    InitialWeightLbs = ""
    LastRollWeightLbs = ""
    LastWeighedDate = ""
    FilmKey = $filmKey
    CoreType = ""
    CoreWeightLbs = ""
    LfWeightLbsPerFt = ""
    PricePerLf = ""
    PurchaseCost = ""
    Notes = "ExceptionResolved=missing_width; SourceSheet=$($exception.sheet); SourceRow=$($exception.row_number); WidthResolution=$($resolution.note); RawDescription=$($exception.raw_description)"
    HasEverBeenCheckedOut = "false"
    LastCheckoutJob = ""
    LastCheckoutDate = ""
    ZeroedDate = ""
    ZeroedReason = ""
    ZeroedBy = ""
  }

  if ($rowsById.ContainsKey($boxId)) {
    $rowsById[$boxId] = $newRow
    $updatedCount++
  } else {
    $rowsById[$boxId] = $newRow
    $insertedCount++
  }
}

$resolvedWithWidths = @($rowsById.Values | Sort-Object BoxID)
$resolvedWithWidths | Export-Csv -LiteralPath $OutputResolvedCsvPath -NoTypeInformation -Encoding UTF8

$resolvedDuplicateIds = @{}
foreach ($collision in $collisionResolutions) {
  if (-not [string]::IsNullOrWhiteSpace($collision.box_id)) {
    $resolvedDuplicateIds[$collision.box_id] = $true
  }
}

$resolvedWidthKeys = @{}
foreach ($resolution in $allWidthResolutions) {
  $key = "$($resolution.sheet)|$($resolution.row_number)|$($resolution.reason)"
  $resolvedWidthKeys[$key] = $true
}

$remainingExceptions = @()
foreach ($exception in $exceptions) {
  $isResolved = $false

  if ($exception.reason -eq "missing_width") {
    $key = "$($exception.sheet)|$($exception.row_number)|$($exception.reason)"
    if ($resolvedWidthKeys.ContainsKey($key)) {
      $isResolved = $true
    }
  } elseif ($exception.reason -eq "duplicate_box_id") {
    $idToken = "$($exception.parsed_id_candidate)".Trim().ToUpperInvariant()
    $boxId = Build-BoxId -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
    if ($resolvedDuplicateIds.ContainsKey($boxId)) {
      $isResolved = $true
    }
  }

  if (-not $isResolved) {
    $remainingExceptions += $exception
  }
}

$remainingExceptions | Export-Csv -LiteralPath $OutputRemainingExceptionsCsvPath -NoTypeInformation -Encoding UTF8

$duplicateCount = (@($resolvedWithWidths | Group-Object BoxID | Where-Object { $_.Count -gt 1 })).Count
$invalidCount = (@($resolvedWithWidths | Where-Object {
      [string]::IsNullOrWhiteSpace($_.BoxID) -or
      [string]::IsNullOrWhiteSpace($_.Manufacturer) -or
      [string]::IsNullOrWhiteSpace($_.FilmName) -or
      ([double]$_.WidthIn) -le 0 -or
      ([int]$_.InitialFeet) -le 0 -or
      ([int]$_.FeetAvailable) -le 0 -or
      $_.OrderDate -notmatch "^\d{4}-\d{2}-\d{2}$" -or
      $_.ReceivedDate -notmatch "^\d{4}-\d{2}-\d{2}$"
    })).Count

$summary = [pscustomobject][ordered]@{
  generated_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  profile = $Profile
  run_dir = $RunDir
  default_prefix = $DefaultPrefix
  legacy_m_prefix = $LegacyMPrefix
  total_width_resolutions = $allWidthResolutions.Count
  width_resolutions_auto_added = $newWidthResolutions.Count
  inserted_rows_from_missing_width = $insertedCount
  updated_rows_from_missing_width = $updatedCount
  remaining_exceptions_count = $remainingExceptions.Count
  remaining_exceptions_by_reason = @(
    $remainingExceptions |
    Group-Object reason |
    Sort-Object Name |
    ForEach-Object {
      [pscustomobject]@{
        reason = $_.Name
        count = $_.Count
      }
    }
  )
  duplicate_box_id_count_in_resolved_output = $duplicateCount
  invalid_row_count_in_resolved_output = $invalidCount
  canonicalized_input_box_id_count = $canonicalizedInputBoxIds
  canonicalized_input_collision_count = $canonicalizedInputCollisions.Count
  canonicalized_input_collision_sample = @($canonicalizedInputCollisions | Select-Object -First 20)
  conflicts = $conflicts
  output_files = [pscustomobject]@{
    resolved_csv = $OutputResolvedCsvPath
    remaining_exceptions_csv = $OutputRemainingExceptionsCsvPath
    width_resolution_csv = $WidthResCsvPath
  }
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputSummaryJsonPath -Encoding UTF8

Write-Host "Width resolutions applied."
Write-Host "Resolved rows: $($resolvedWithWidths.Count)"
Write-Host "Remaining exceptions: $($remainingExceptions.Count)"
Write-Host "Duplicate BoxID count: $duplicateCount"
Write-Host "Invalid row count: $invalidCount"
Write-Host "Summary: $OutputSummaryJsonPath"
