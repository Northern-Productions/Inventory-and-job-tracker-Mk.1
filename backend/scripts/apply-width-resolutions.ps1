param(
  [string]$ResolvedCsvPath = "backend/migration-dry-runs/il-assigned/boxes_raw_resolved.csv",
  [string]$ExceptionsCsvPath = "backend/migration-dry-runs/il-assigned/boxes_exceptions.csv",
  [string]$WidthResCsvPath = "backend/migration-dry-runs/il-assigned/exception_width_resolutions.csv",
  [string]$CollisionResCsvPath = "backend/migration-dry-runs/il-assigned/collision_resolutions.csv",
  [string]$OutputResolvedCsvPath = "backend/migration-dry-runs/il-assigned/boxes_raw_resolved_with_widths.csv",
  [string]$OutputRemainingExceptionsCsvPath = "backend/migration-dry-runs/il-assigned/boxes_exceptions_remaining.csv",
  [string]$OutputSummaryJsonPath = "backend/migration-dry-runs/il-assigned/width_resolution_summary.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

foreach ($requiredPath in @($ResolvedCsvPath, $ExceptionsCsvPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required file not found: $requiredPath"
  }
}

function Parse-IdToken {
  param([string]$Description)
  $match = [regex]::Match("$Description", "^(?<id>[A-Za-z0-9]{2,12})\s*-")
  if ($match.Success) {
    return $match.Groups["id"].Value.ToUpperInvariant()
  }
  return ""
}

function Build-BoxId {
  param([string]$IdToken)
  if ([string]::IsNullOrWhiteSpace($IdToken)) {
    return ""
  }
  if ($IdToken.StartsWith("M", [System.StringComparison]::OrdinalIgnoreCase)) {
    return $IdToken
  }
  return "IL-$IdToken"
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

  $match = [regex]::Match("$Description", "^[A-Za-z0-9]{2,12}\s*-\s*(?<rest>.+)$")
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
  $boxId = Build-BoxId -IdToken $idToken

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
foreach ($row in $rows) {
  $rowsById[$row.BoxID] = $row
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
  $boxId = Build-BoxId -IdToken $idToken
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

  $manufacturer = "$($exception.sheet)".Trim()
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
    $boxId = Build-BoxId -IdToken $idToken
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
