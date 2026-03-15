param(
  [Parameter(Mandatory = $true)]
  [string]$BoxId,
  [Parameter(Mandatory = $true)]
  [ValidateSet("keep", "move")]
  [string]$Decision,
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$RunDir = "",
  [string]$TargetManufacturer = "",
  [string]$ReviewQueueCsvPath = "",
  [string]$CombinedCsvPath = "",
  [string]$AppendedCsvPath = "",
  [string]$ActionsCsvPath = ""
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
  $ReviewQueueCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/vinyl_manual_review_queue.csv"
}
if ([string]::IsNullOrWhiteSpace($CombinedCsvPath)) {
  $CombinedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_final_with_zeroed.csv"
}
if ([string]::IsNullOrWhiteSpace($AppendedCsvPath)) {
  $AppendedCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/zeroed_rows_appended.csv"
}
if ([string]::IsNullOrWhiteSpace($ActionsCsvPath)) {
  $ActionsCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/vinyl_manual_review_actions.csv"
}

if (-not (Test-Path -LiteralPath $ReviewQueueCsvPath)) {
  throw "Manual review queue CSV not found: $ReviewQueueCsvPath"
}
if (-not (Test-Path -LiteralPath $CombinedCsvPath)) {
  throw "Combined CSV not found: $CombinedCsvPath"
}
if (-not (Test-Path -LiteralPath $AppendedCsvPath)) {
  throw "Appended CSV not found: $AppendedCsvPath"
}

$actionsDir = Split-Path -Path $ActionsCsvPath -Parent
if (-not [string]::IsNullOrWhiteSpace($actionsDir) -and -not (Test-Path -LiteralPath $actionsDir)) {
  [void](New-Item -Path $actionsDir -ItemType Directory -Force)
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

function Append-NoteSuffix {
  param(
    [string]$NoteBase,
    [string]$Suffix
  )

  $base = "$NoteBase"
  if ([string]::IsNullOrWhiteSpace($base)) {
    return $Suffix
  }
  return "$base; $Suffix"
}

$queueRows = @(Import-Csv -LiteralPath $ReviewQueueCsvPath)
$combinedRows = @(Import-Csv -LiteralPath $CombinedCsvPath)
$appendedRows = @(Import-Csv -LiteralPath $AppendedCsvPath)

$boxIdTrimmed = "$BoxId".Trim()
$matches = @($queueRows | Where-Object { "$($_.box_id)".Trim() -eq $boxIdTrimmed })
if ($matches.Count -ne 1) {
  throw "Expected exactly one queue row for BoxID '$boxIdTrimmed', found $($matches.Count)."
}

$queueRow = $matches[0]
$currentManufacturer = "$($queueRow.current_manufacturer)".Trim()
$suggestedManufacturer = "$($queueRow.suggested_manufacturer)".Trim()

$resolvedManufacturer = $currentManufacturer
if ($Decision -eq "move") {
  if ([string]::IsNullOrWhiteSpace($TargetManufacturer)) {
    $resolvedManufacturer = $suggestedManufacturer
  } else {
    $resolvedManufacturer = "$TargetManufacturer".Trim()
  }

  if ([string]::IsNullOrWhiteSpace($resolvedManufacturer)) {
    throw "Move decision requires a non-empty target manufacturer."
  }
}

$decisionUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")

$combinedMatch = @($combinedRows | Where-Object { "$($_.BoxID)".Trim() -eq $boxIdTrimmed })
if ($combinedMatch.Count -ne 1) {
  throw "Expected exactly one combined row for BoxID '$boxIdTrimmed', found $($combinedMatch.Count)."
}
$combinedRow = $combinedMatch[0]

$appendedMatch = @($appendedRows | Where-Object { "$($_.BoxID)".Trim() -eq $boxIdTrimmed })
if ($appendedMatch.Count -ne 1) {
  throw "Expected exactly one appended row for BoxID '$boxIdTrimmed', found $($appendedMatch.Count)."
}
$appendedRow = $appendedMatch[0]

$beforeCombinedManufacturer = "$($combinedRow.Manufacturer)".Trim()
$beforeAppendedManufacturer = "$($appendedRow.Manufacturer)".Trim()

if ($Decision -eq "move") {
  $combinedRow.Manufacturer = $resolvedManufacturer
  $combinedRow.FilmKey = Build-FilmKey -Manufacturer $resolvedManufacturer -FilmName "$($combinedRow.FilmName)"
  $combinedRow.Notes = Append-NoteSuffix -NoteBase "$($combinedRow.Notes)" -Suffix "ManufacturerManualReview=move; ManufacturerBefore=$beforeCombinedManufacturer; ManufacturerAfter=$resolvedManufacturer; DecisionAtUtc=$decisionUtc"

  $appendedRow.Manufacturer = $resolvedManufacturer
  $appendedRow.FilmKey = Build-FilmKey -Manufacturer $resolvedManufacturer -FilmName "$($appendedRow.FilmName)"
  $appendedRow.Notes = Append-NoteSuffix -NoteBase "$($appendedRow.Notes)" -Suffix "ManufacturerManualReview=move; ManufacturerBefore=$beforeAppendedManufacturer; ManufacturerAfter=$resolvedManufacturer; DecisionAtUtc=$decisionUtc"
}

if ($Decision -eq "keep") {
  $combinedRow.Notes = Append-NoteSuffix -NoteBase "$($combinedRow.Notes)" -Suffix "ManufacturerManualReview=keep; ManufacturerKept=$beforeCombinedManufacturer; DecisionAtUtc=$decisionUtc"
  $appendedRow.Notes = Append-NoteSuffix -NoteBase "$($appendedRow.Notes)" -Suffix "ManufacturerManualReview=keep; ManufacturerKept=$beforeAppendedManufacturer; DecisionAtUtc=$decisionUtc"
}

foreach ($row in $queueRows) {
  if ("$($row.box_id)".Trim() -ne $boxIdTrimmed) {
    continue
  }

  if (-not ($row.PSObject.Properties.Name -contains "decision_status")) {
    $row | Add-Member -NotePropertyName "decision_status" -NotePropertyValue "" -Force
  }
  if (-not ($row.PSObject.Properties.Name -contains "decision_action")) {
    $row | Add-Member -NotePropertyName "decision_action" -NotePropertyValue "" -Force
  }
  if (-not ($row.PSObject.Properties.Name -contains "decision_manufacturer")) {
    $row | Add-Member -NotePropertyName "decision_manufacturer" -NotePropertyValue "" -Force
  }
  if (-not ($row.PSObject.Properties.Name -contains "decision_at_utc")) {
    $row | Add-Member -NotePropertyName "decision_at_utc" -NotePropertyValue "" -Force
  }

  $row.decision_status = "resolved"
  $row.decision_action = $Decision
  $row.decision_manufacturer = if ($Decision -eq "move") { $resolvedManufacturer } else { $currentManufacturer }
  $row.decision_at_utc = $decisionUtc
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
  throw "Validation failed: invalid row(s) found in combined CSV."
}

$combinedRows | Export-Csv -LiteralPath $CombinedCsvPath -NoTypeInformation -Encoding UTF8
$appendedRows | Export-Csv -LiteralPath $AppendedCsvPath -NoTypeInformation -Encoding UTF8
$queueRows | Export-Csv -LiteralPath $ReviewQueueCsvPath -NoTypeInformation -Encoding UTF8

if (-not (Test-Path -LiteralPath $ActionsCsvPath)) {
  "timestamp_utc,box_id,decision,manufacturer_before,manufacturer_after,source,source_row,notes" |
  Set-Content -LiteralPath $ActionsCsvPath -Encoding UTF8
}

$sourceValue = ""
if ($queueRow.PSObject.Properties.Name -contains "source") {
  $sourceValue = "$($queueRow.source)"
}

$sourceRowValue = ""
if ($queueRow.PSObject.Properties.Name -contains "source_row") {
  $sourceRowValue = "$($queueRow.source_row)"
}

$logLine = "$decisionUtc,$boxIdTrimmed,$Decision,$beforeCombinedManufacturer,$($combinedRow.Manufacturer),$sourceValue,$sourceRowValue,manual_review"
Add-Content -LiteralPath $ActionsCsvPath -Encoding UTF8 -Value $logLine

Write-Host "Manual review decision applied."
Write-Host "BoxID: $boxIdTrimmed"
Write-Host "Decision: $Decision"
Write-Host "Manufacturer: $beforeCombinedManufacturer -> $($combinedRow.Manufacturer)"
