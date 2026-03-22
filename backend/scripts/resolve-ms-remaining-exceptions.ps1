param(
  [string]$RunDir = "backend/migration-dry-runs/ms-inventory",
  [string]$FinalCsvPath = "",
  [string]$RemainingExceptionsCsvPath = "",
  [string]$CollisionsCsvPath = "",
  [string]$FallbackInventoryDate = "2025-07-31",
  [string]$DefaultPrefix = "MS1",
  [string]$LegacyMPrefix = "MS1",
  [string]$SummaryPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($FinalCsvPath)) {
  $FinalCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_final_with_zeroed.csv"
}
if ([string]::IsNullOrWhiteSpace($RemainingExceptionsCsvPath)) {
  $RemainingExceptionsCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_exceptions_remaining.csv"
}
if ([string]::IsNullOrWhiteSpace($CollisionsCsvPath)) {
  $CollisionsCsvPath = Join-Path -Path $RunDir -ChildPath "id_collisions.csv"
}
if ([string]::IsNullOrWhiteSpace($SummaryPath)) {
  $SummaryPath = Join-Path -Path $RunDir -ChildPath "remaining_exception_resolution_summary.json"
}

foreach ($requiredPath in @($FinalCsvPath, $RemainingExceptionsCsvPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required file not found: $requiredPath"
  }
}

function Test-DateYmd {
  param([string]$Value)
  return "$Value" -match "^\d{4}-\d{2}-\d{2}$"
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

function Resolve-Manufacturer {
  param([string]$SheetName)

  $sheet = "$SheetName".Trim()
  switch -Regex ($sheet.ToUpperInvariant()) {
    "^LLUMARVISTA$" { return "Llumar" }
    "^MADICO$" { return "ASWFVKOOL" }
    default { return $sheet }
  }
}

function Parse-Width {
  param(
    [string]$ParsedWidthCandidate,
    [string]$Description
  )

  $hint = [regex]::Match("$Description", '(?<w>\d{2,3})\s*"')
  if ($hint.Success) {
    $quoted = [int]$hint.Groups["w"].Value
    if ($quoted -gt 0) {
      return $quoted
    }
  }

  $candidate = 0
  if ([int]::TryParse("$ParsedWidthCandidate", [ref]$candidate)) {
    if ($candidate -ge 12 -and $candidate -le 96) {
      return $candidate
    }
  }

  $tail = [regex]::Match("$Description", "(?<w>\d{2,3})\s*$")
  if ($tail.Success) {
    $tailWidth = [int]$tail.Groups["w"].Value
    if ($tailWidth -ge 12 -and $tailWidth -le 96) {
      return $tailWidth
    }
  }

  return 60
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
    return [regex]::Replace($descriptionText, "\s+", " ")
  }

  $rest = [regex]::Replace($match.Groups["rest"].Value.Trim(), "\s+", " ")
  $patternQuoted = "(?i)\b" + [regex]::Escape([string]$Width) + '\s*"'
  $withoutWidth = [regex]::Replace($rest, $patternQuoted, "", 1)
  if ($withoutWidth -eq $rest) {
    $patternPlain = "(?i)\b" + [regex]::Escape([string]$Width) + "\b"
    $withoutWidth = [regex]::Replace($rest, $patternPlain, "", 1)
  }

  $withoutWidth = [regex]::Replace($withoutWidth, "\s+", " ").Trim(" ", "-", ",")
  if ([string]::IsNullOrWhiteSpace($withoutWidth)) {
    return [regex]::Replace($descriptionText, "\s+", " ")
  }
  return $withoutWidth
}

function Parse-PositiveFeet {
  param([string]$RawValue)

  $clean = "$RawValue".Trim().Replace(",", "").Replace("'", "")
  $clean = [regex]::Replace($clean, "[^0-9\.\-]", "")
  if ([string]::IsNullOrWhiteSpace($clean) -or $clean -eq "." -or $clean -eq "-" -or $clean -eq "-.") {
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

function New-BoxesRawRow {
  param(
    [string]$BoxID,
    [string]$Manufacturer,
    [string]$FilmName,
    [int]$WidthIn,
    [int]$InitialFeet,
    [int]$FeetAvailable,
    [string]$Status,
    [string]$LotRun,
    [string]$OrderDate,
    [string]$ReceivedDate,
    [string]$ZeroedDate,
    [string]$ZeroedReason,
    [string]$ZeroedBy,
    [string]$Notes
  )

  $filmKey = "$($Manufacturer.ToUpperInvariant())|$($FilmName.ToUpperInvariant())"

  return [pscustomobject][ordered]@{
    BoxID = $BoxID
    Manufacturer = $Manufacturer
    FilmName = $FilmName
    WidthIn = "$WidthIn"
    InitialFeet = "$InitialFeet"
    FeetAvailable = "$FeetAvailable"
    LotRun = $LotRun
    Status = $Status
    OrderDate = $OrderDate
    ReceivedDate = $ReceivedDate
    InitialWeightLbs = ""
    LastRollWeightLbs = ""
    LastWeighedDate = ""
    FilmKey = $filmKey
    CoreType = ""
    CoreWeightLbs = ""
    LfWeightLbsPerFt = ""
    PricePerLf = ""
    PurchaseCost = ""
    Notes = $Notes
    HasEverBeenCheckedOut = "false"
    LastCheckoutJob = ""
    LastCheckoutDate = ""
    ZeroedDate = $ZeroedDate
    ZeroedReason = $ZeroedReason
    ZeroedBy = $ZeroedBy
  }
}

$finalRows = @(Import-Csv -LiteralPath $FinalCsvPath)
$exceptions = @(Import-Csv -LiteralPath $RemainingExceptionsCsvPath)
$collisions = @()
if (Test-Path -LiteralPath $CollisionsCsvPath) {
  $collisions = @(Import-Csv -LiteralPath $CollisionsCsvPath)
}

if ($finalRows.Count -eq 0) {
  throw "Final CSV has no rows: $FinalCsvPath"
}

$rowsById = @{}
foreach ($row in $finalRows) {
  $id = "$($row.BoxID)".Trim()
  if (-not [string]::IsNullOrWhiteSpace($id)) {
    $rowsById[$id] = $row
  }
}

$resolvedRows = New-Object System.Collections.Generic.List[object]
$unresolvedRows = New-Object System.Collections.Generic.List[object]
$inserted = 0
$updated = 0
$resolvedCollisionIds = New-Object System.Collections.Generic.List[object]

foreach ($exception in $exceptions) {
  $reason = "$($exception.reason)".Trim()
  $sheet = "$($exception.sheet)".Trim()
  $rowNumber = "$($exception.row_number)".Trim()

  if ($reason -eq "duplicate_box_id") {
    $idToken = "$($exception.parsed_id_candidate)".Trim().ToUpperInvariant()
    $boxId = Build-BoxId -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
    if (-not [string]::IsNullOrWhiteSpace($boxId)) {
      $resolvedCollisionIds.Add($boxId)
      $resolvedRows.Add([pscustomobject]@{
          sheet = $sheet
          row_number = $rowNumber
          reason = $reason
          action = "drop_duplicate_keep_first"
          box_id = $boxId
        })
      continue
    }
  }

  if ($reason -eq "non_positive_quantity" -or $reason -eq "missing_inventory_date") {
    $idToken = "$($exception.parsed_id_candidate)".Trim().ToUpperInvariant()
    if ([string]::IsNullOrWhiteSpace($idToken)) {
      $idToken = Parse-IdToken -Description $exception.raw_description
    }

    $boxId = Build-BoxId -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix
    if ([string]::IsNullOrWhiteSpace($boxId)) {
      $unresolvedRows.Add($exception)
      continue
    }

    $width = Parse-Width -ParsedWidthCandidate "$($exception.parsed_width_candidate)" -Description "$($exception.raw_description)"
    if ($width -le 0) {
      $unresolvedRows.Add($exception)
      continue
    }

    $manufacturer = Resolve-Manufacturer -SheetName $sheet
    $filmName = Build-FilmName -Description "$($exception.raw_description)" -Width $width
    if ([string]::IsNullOrWhiteSpace($filmName)) {
      $unresolvedRows.Add($exception)
      continue
    }

    $lotRun = "$($exception.raw_lot)".Trim()
    $date = "$($exception.inventory_date)".Trim()
    if (-not (Test-DateYmd -Value $date)) {
      $date = $FallbackInventoryDate
    }
    if (-not (Test-DateYmd -Value $date)) {
      $unresolvedRows.Add($exception)
      continue
    }

    $initialFeet = 0
    $feetAvailable = 0
    $status = "ZEROED"
    $zeroedDate = $date
    $zeroedReason = "Resolved from remaining exceptions"
    $zeroedBy = "migration"
    $noteAction = "non_positive_to_zeroed"

    if ($reason -eq "missing_inventory_date") {
      $feetParsed = Parse-PositiveFeet -RawValue "$($exception.raw_qty)"
      if ($null -eq $feetParsed) {
        $unresolvedRows.Add($exception)
        continue
      }
      $initialFeet = [int]$feetParsed
      $feetAvailable = [int]$feetParsed
      $status = "IN_STOCK"
      $zeroedDate = ""
      $zeroedReason = ""
      $zeroedBy = ""
      $noteAction = "missing_inventory_date_set_to_fallback"
    }

    $notes = "RemainingExceptionResolved=$noteAction; SourceSheet=$sheet; SourceRow=$rowNumber; RawDescription=$($exception.raw_description)"
    $newRow = New-BoxesRawRow `
      -BoxID $boxId `
      -Manufacturer $manufacturer `
      -FilmName $filmName `
      -WidthIn $width `
      -InitialFeet $initialFeet `
      -FeetAvailable $feetAvailable `
      -Status $status `
      -LotRun $lotRun `
      -OrderDate $date `
      -ReceivedDate $date `
      -ZeroedDate $zeroedDate `
      -ZeroedReason $zeroedReason `
      -ZeroedBy $zeroedBy `
      -Notes $notes

    if ($rowsById.ContainsKey($boxId)) {
      $rowsById[$boxId] = $newRow
      $updated++
    } else {
      $rowsById[$boxId] = $newRow
      $inserted++
    }

    $resolvedRows.Add([pscustomobject]@{
        sheet = $sheet
        row_number = $rowNumber
        reason = $reason
        action = $noteAction
        box_id = $boxId
      })
    continue
  }

  $unresolvedRows.Add($exception)
}

$resolvedCollisions = @()
if ($collisions.Count -gt 0 -and $resolvedCollisionIds.Count -gt 0) {
  $lookup = @{}
  foreach ($id in $resolvedCollisionIds) {
    $lookup["$id"] = $true
  }
  $resolvedCollisions = @($collisions | Where-Object { $lookup.ContainsKey("$($_.box_id)".Trim().ToUpperInvariant()) })
}

$finalOutRows = @($rowsById.Values | Sort-Object BoxID)
$duplicateIds = @($finalOutRows | Group-Object BoxID | Where-Object { $_.Count -gt 1 })
if ($duplicateIds.Count -gt 0) {
  throw "Validation failed: duplicate BoxID values after exception resolution."
}

$invalidRows = @(
  $finalOutRows | Where-Object {
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
  throw "Validation failed: invalid row(s) after exception resolution."
}

$finalOutRows | Export-Csv -LiteralPath $FinalCsvPath -NoTypeInformation -Encoding UTF8
$unresolvedRows | Export-Csv -LiteralPath $RemainingExceptionsCsvPath -NoTypeInformation -Encoding UTF8

$summary = [ordered]@{
  generated_at_utc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  run_dir = $RunDir
  final_csv = $FinalCsvPath
  remaining_exceptions_csv = $RemainingExceptionsCsvPath
  fallback_inventory_date = $FallbackInventoryDate
  processed_exception_rows = $exceptions.Count
  resolved_rows = $resolvedRows.Count
  unresolved_rows = $unresolvedRows.Count
  inserted_rows = $inserted
  updated_rows = $updated
  resolved_collision_rows = $resolvedCollisions.Count
  duplicate_box_ids_after = $duplicateIds.Count
  invalid_rows_after = $invalidRows.Count
  resolution_breakdown = @(
    $resolvedRows | Group-Object action | Sort-Object Name | ForEach-Object {
      [pscustomobject]@{
        action = $_.Name
        count = $_.Count
      }
    }
  )
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SummaryPath -Encoding UTF8

Write-Host "Remaining exception resolution complete."
Write-Host "Processed:  $($exceptions.Count)"
Write-Host "Resolved:   $($resolvedRows.Count)"
Write-Host "Unresolved: $($unresolvedRows.Count)"
Write-Host "Inserted:   $inserted"
Write-Host "Updated:    $updated"
Write-Host "Summary:    $SummaryPath"
