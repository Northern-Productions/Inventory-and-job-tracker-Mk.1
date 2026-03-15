param(
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$RunDir = "",
  [string]$ReviewQueueCsvPath = "",
  [string]$CombinedCsvPath = "",
  [string]$AppendedCsvPath = "",
  [string]$DecisionsCsvPath = "",
  [string]$SummaryJsonPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$profileRunDirs = @{
  IL = "backend/migration-dry-runs/il-assigned"
  MS = "backend/migration-dry-runs/ms-inventory"
}
if ([string]::IsNullOrWhiteSpace($RunDir)) {
  $RunDir = [string]$profileRunDirs[$Profile]
}
if ([string]::IsNullOrWhiteSpace($RunDir)) {
  throw "Unable to resolve run directory for profile: $Profile"
}

if ([string]::IsNullOrWhiteSpace($ReviewQueueCsvPath)) {
  $ReviewQueueCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/vinyl_review_queue.csv"
}
if ([string]::IsNullOrWhiteSpace($CombinedCsvPath)) {
  $CombinedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_final_with_zeroed.csv"
}
if ([string]::IsNullOrWhiteSpace($AppendedCsvPath)) {
  $AppendedCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/zeroed_rows_appended.csv"
}
if ([string]::IsNullOrWhiteSpace($DecisionsCsvPath)) {
  $DecisionsCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/vinyl_review_decisions_applied.csv"
}
if ([string]::IsNullOrWhiteSpace($SummaryJsonPath)) {
  $SummaryJsonPath = Join-Path -Path $RunDir -ChildPath "zeroed/vinyl_review_apply_summary.json"
}

if (-not (Test-Path -LiteralPath $ReviewQueueCsvPath)) {
  throw "Review queue CSV not found: $ReviewQueueCsvPath"
}
if (-not (Test-Path -LiteralPath $CombinedCsvPath)) {
  throw "Combined CSV not found: $CombinedCsvPath"
}
if (-not (Test-Path -LiteralPath $AppendedCsvPath)) {
  throw "Appended CSV not found: $AppendedCsvPath"
}

$outputDirs = @(
  (Split-Path -Path $DecisionsCsvPath -Parent),
  (Split-Path -Path $SummaryJsonPath -Parent)
)
foreach ($dir in $outputDirs) {
  if ([string]::IsNullOrWhiteSpace($dir)) {
    continue
  }
  if (-not (Test-Path -LiteralPath $dir)) {
    [void](New-Item -Path $dir -ItemType Directory -Force)
  }
}

function Test-DateYmd {
  param([string]$Value)
  return "$Value" -match "^\d{4}-\d{2}-\d{2}$"
}

function Build-FilmKey {
  param(
    [string]$Manufacturer,
    [string]$FilmName
  )
  return "$($Manufacturer.ToUpperInvariant())|$($FilmName.ToUpperInvariant())"
}

$queueRows = @(Import-Csv -LiteralPath $ReviewQueueCsvPath)
$combinedRows = @(Import-Csv -LiteralPath $CombinedCsvPath)
$appendedRows = @(Import-Csv -LiteralPath $AppendedCsvPath)

# Conservative hold list for ambiguous high-confidence shorthand patterns.
$conservativeHoldBoxIds = @()
if ($Profile -eq "IL") {
  $conservativeHoldBoxIds = @("IL1-3286")
}
$holdLookup = @{}
foreach ($id in $conservativeHoldBoxIds) {
  $holdLookup[$id] = $true
}

$decisions = New-Object System.Collections.Generic.List[object]
$moveMap = @{}

foreach ($row in $queueRows) {
  $boxId = "$($row.box_id)".Trim()
  $current = "$($row.current_manufacturer)".Trim()
  $suggested = "$($row.suggested_manufacturer)".Trim()
  $confidence = "$($row.confidence)".Trim().ToLowerInvariant()

  $action = "keep"
  $decisionReason = "No manufacturer change suggested."

  if ($suggested -ne $current) {
    if ($confidence -eq "high") {
      if ($holdLookup.ContainsKey($boxId)) {
        $action = "keep"
        $decisionReason = "Conservative hold for shorthand/ambiguous pattern."
      } else {
        $action = "move"
        $decisionReason = "High-confidence suggestion auto-applied."
        $moveMap[$boxId] = $suggested
      }
    } else {
      $action = "keep"
      $decisionReason = "Medium/low confidence kept conservative."
    }
  }

  $decisions.Add([pscustomobject]@{
      box_id = $boxId
      film_name = $row.film_name
      width_in = $row.width_in
      source = $row.source
      source_row = $row.source_row
      confidence = $row.confidence
      current_manufacturer = $current
      suggested_manufacturer = $suggested
      final_action = $action
      final_manufacturer = if ($action -eq "move") { $suggested } else { $current }
      decision_reason = $decisionReason
      queue_reason = $row.reason
    })
}

$movedCombined = 0
foreach ($row in $combinedRows) {
  $boxId = "$($row.BoxID)".Trim()
  if (-not $moveMap.ContainsKey($boxId)) {
    continue
  }

  $newManufacturer = "$($moveMap[$boxId])".Trim()
  $oldManufacturer = "$($row.Manufacturer)".Trim()
  if ([string]::IsNullOrWhiteSpace($newManufacturer) -or $newManufacturer -eq $oldManufacturer) {
    continue
  }

  $row.Manufacturer = $newManufacturer
  $row.FilmKey = Build-FilmKey -Manufacturer $newManufacturer -FilmName "$($row.FilmName)"

  $noteBase = "$($row.Notes)"
  if ([string]::IsNullOrWhiteSpace($noteBase)) {
    $noteBase = ""
  }
  $suffix = "ManufacturerReview=auto_high_confidence; ManufacturerBefore=$oldManufacturer; ManufacturerAfter=$newManufacturer"
  if ($noteBase -match "ManufacturerReview=auto_high_confidence") {
    # Keep idempotent reruns stable.
    $row.Notes = $noteBase
  } elseif ([string]::IsNullOrWhiteSpace($noteBase)) {
    $row.Notes = $suffix
  } else {
    $row.Notes = "$noteBase; $suffix"
  }

  $movedCombined++
}

$movedAppended = 0
foreach ($row in $appendedRows) {
  $boxId = "$($row.BoxID)".Trim()
  if (-not $moveMap.ContainsKey($boxId)) {
    continue
  }

  $newManufacturer = "$($moveMap[$boxId])".Trim()
  $oldManufacturer = "$($row.Manufacturer)".Trim()
  if ([string]::IsNullOrWhiteSpace($newManufacturer) -or $newManufacturer -eq $oldManufacturer) {
    continue
  }

  $row.Manufacturer = $newManufacturer
  $row.FilmKey = Build-FilmKey -Manufacturer $newManufacturer -FilmName "$($row.FilmName)"

  $noteBase = "$($row.Notes)"
  if ([string]::IsNullOrWhiteSpace($noteBase)) {
    $noteBase = ""
  }
  $suffix = "ManufacturerReview=auto_high_confidence; ManufacturerBefore=$oldManufacturer; ManufacturerAfter=$newManufacturer"
  if ($noteBase -match "ManufacturerReview=auto_high_confidence") {
    $row.Notes = $noteBase
  } elseif ([string]::IsNullOrWhiteSpace($noteBase)) {
    $row.Notes = $suffix
  } else {
    $row.Notes = "$noteBase; $suffix"
  }

  $movedAppended++
}

$duplicates = @($combinedRows | Group-Object BoxID | Where-Object { $_.Count -gt 1 })
if ($duplicates.Count -gt 0) {
  throw "Validation failed: duplicate BoxID values found in combined CSV."
}

$invalidRows = @(
  $combinedRows | Where-Object {
    [string]::IsNullOrWhiteSpace($_.BoxID) -or
    [string]::IsNullOrWhiteSpace($_.Manufacturer) -or
    [string]::IsNullOrWhiteSpace($_.FilmName) -or
    ([double]$_.WidthIn) -le 0 -or
    ([int]$_.InitialFeet) -lt 0 -or
    ([int]$_.FeetAvailable) -lt 0 -or
    ([int]$_.FeetAvailable) -gt ([int]$_.InitialFeet) -or
    -not (Test-DateYmd -Value $_.OrderDate)
  }
)
if ($invalidRows.Count -gt 0) {
  throw "Validation failed: invalid row(s) found in combined CSV after review decisions."
}

$combinedRows | Export-Csv -LiteralPath $CombinedCsvPath -NoTypeInformation -Encoding UTF8
$appendedRows | Export-Csv -LiteralPath $AppendedCsvPath -NoTypeInformation -Encoding UTF8
$decisions | Export-Csv -LiteralPath $DecisionsCsvPath -NoTypeInformation -Encoding UTF8

$actionBreakdown = @($decisions | Group-Object final_action | Sort-Object Count -Descending | ForEach-Object {
    [pscustomobject]@{
      action = $_.Name
      rows = $_.Count
    }
  })

$moveBreakdown = @($decisions | Where-Object { $_.final_action -eq "move" } | Group-Object final_manufacturer | Sort-Object Count -Descending | ForEach-Object {
    [pscustomobject]@{
      manufacturer = $_.Name
      rows = $_.Count
    }
  })

$summary = [ordered]@{
  generated_at_utc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  profile = $Profile
  run_dir = $RunDir
  review_queue_csv = $ReviewQueueCsvPath
  combined_csv = $CombinedCsvPath
  appended_csv = $AppendedCsvPath
  decisions_csv = $DecisionsCsvPath
  review_rows = $queueRows.Count
  moves_planned = $moveMap.Keys.Count
  moved_rows_in_combined = $movedCombined
  moved_rows_in_appended = $movedAppended
  conservative_hold_box_ids = $conservativeHoldBoxIds
  duplicate_box_ids_after_update = $duplicates.Count
  invalid_rows_after_update = $invalidRows.Count
  action_breakdown = $actionBreakdown
  move_breakdown = $moveBreakdown
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $SummaryJsonPath -Encoding UTF8

Write-Host "Vinyl review decisions applied."
Write-Host "Queue rows: $($queueRows.Count)"
Write-Host "Moved rows: $($moveMap.Keys.Count)"
Write-Host "Combined updates: $movedCombined"
Write-Host "Appended updates: $movedAppended"
