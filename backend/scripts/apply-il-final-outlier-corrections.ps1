param(
  [string]$FinalCsvPath = "backend/migration-dry-runs/il-assigned/boxes_raw_final_with_zeroed.csv",
  [string]$SummaryJsonPath = "backend/migration-dry-runs/il-assigned/outlier_corrections_summary.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $FinalCsvPath)) {
  throw "Final CSV not found: $FinalCsvPath"
}

function Build-FilmKey {
  param(
    [string]$Manufacturer,
    [string]$FilmName
  )
  return "$($Manufacturer.ToUpperInvariant())|$($FilmName.ToUpperInvariant())"
}

function Append-Note {
  param(
    [string]$Base,
    [string]$Suffix
  )
  if ([string]::IsNullOrWhiteSpace($Base)) {
    return $Suffix
  }
  return "$Base; $Suffix"
}

$rows = @(Import-Csv -LiteralPath $FinalCsvPath)

# Targeted corrections for known model-code width parse errors.
$corrections = @(
  [pscustomobject]@{
    BoxID = "IL-1364"
    WidthIn = "60"
    FilmName = "Solyx Silver Etch Stripe SX-2002"
    Reason = "Model code SX-2002 parsed as width 2"
  },
  [pscustomobject]@{
    BoxID = "IL-1436"
    WidthIn = "60"
    FilmName = "VERTICAL STRIPES SX-9200"
    Reason = "Model code SX-9200 parsed as width 200"
  },
  [pscustomobject]@{
    BoxID = "IL-1437"
    WidthIn = "60"
    FilmName = "VERTICAL STRIPES SX-9200"
    Reason = "Model code SX-9200 parsed as width 200"
  },
  [pscustomobject]@{
    BoxID = "IL-1456"
    WidthIn = "18"
    FilmName = "WHITE RICE PAPER SXG-001"
    Reason = "Model code SXG-001 parsed as width 1; sibling SXG row uses 18"
  },
  [pscustomobject]@{
    BoxID = "IL-2670"
    WidthIn = "60"
    FilmName = "Acid Etch SOL SX3-314"
    Reason = "Model code SX3-314 parsed as width 314; same code appears as 60 in IL-6380"
  },
  [pscustomobject]@{
    BoxID = "IL-2865"
    WidthIn = "48"
    FilmName = "Oracal 090 Silver Gray Series"
    Reason = "Series code 751 parsed as width; aligned to Oracal 751 silver rows at 48"
  },
  [pscustomobject]@{
    BoxID = "IL-3289"
    WidthIn = "60"
    FilmName = "DI-NOC PS-959"
    Reason = "Model code PS-959 parsed as width; PS-series DI-NOC row uses 60"
  },
  [pscustomobject]@{
    BoxID = "IL-3401"
    WidthIn = "48"
    FilmName = "3M Di-Noc Wood Grain-1147"
    Reason = "Trailing 164 was malformed width token; Wood Grain DI-NOC rows are 48"
  },
  [pscustomobject]@{
    BoxID = "IL-3753"
    WidthIn = "60"
    FilmName = "DI-NOC OYSTER LINEN F473"
    Reason = "Model code F473 parsed as width; matched ZEROED row IL-3595 at 60"
  }
)

$changed = New-Object System.Collections.Generic.List[object]
$missing = New-Object System.Collections.Generic.List[object]

foreach ($fix in $corrections) {
  $targets = @($rows | Where-Object { "$($_.BoxID)".Trim() -eq $fix.BoxID })
  if ($targets.Count -eq 0) {
    $missing.Add([pscustomobject]@{ box_id = $fix.BoxID; reason = "not_found" })
    continue
  }
  if ($targets.Count -gt 1) {
    throw "Expected one row for $($fix.BoxID), found $($targets.Count)."
  }

  $row = $targets[0]
  $beforeWidth = "$($row.WidthIn)"
  $beforeFilm = "$($row.FilmName)"
  $beforeFilmKey = "$($row.FilmKey)"

  $row.WidthIn = $fix.WidthIn
  if (-not [string]::IsNullOrWhiteSpace($fix.FilmName)) {
    $row.FilmName = $fix.FilmName
  }
  $row.FilmKey = Build-FilmKey -Manufacturer "$($row.Manufacturer)" -FilmName "$($row.FilmName)"

  $noteSuffix = "OutlierFix=2026-03-14; WidthBefore=$beforeWidth; WidthAfter=$($row.WidthIn); FilmBefore=$beforeFilm; FilmAfter=$($row.FilmName); Reason=$($fix.Reason)"
  $row.Notes = Append-Note -Base "$($row.Notes)" -Suffix $noteSuffix

  $changed.Add([pscustomobject]@{
      box_id = $fix.BoxID
      width_before = $beforeWidth
      width_after = "$($row.WidthIn)"
      film_before = $beforeFilm
      film_after = "$($row.FilmName)"
      film_key_before = $beforeFilmKey
      film_key_after = "$($row.FilmKey)"
      reason = $fix.Reason
    })
}

$duplicates = @($rows | Group-Object BoxID | Where-Object { $_.Count -gt 1 })
if ($duplicates.Count -gt 0) {
  throw "Validation failed: duplicate BoxID values after outlier corrections."
}

$invalid = @(
  $rows | Where-Object {
    [string]::IsNullOrWhiteSpace($_.BoxID) -or
    [string]::IsNullOrWhiteSpace($_.Manufacturer) -or
    [string]::IsNullOrWhiteSpace($_.FilmName) -or
    ([double]$_.WidthIn) -le 0 -or
    ([int]$_.InitialFeet) -lt 0 -or
    ([int]$_.FeetAvailable) -lt 0 -or
    ([int]$_.FeetAvailable) -gt ([int]$_.InitialFeet) -or
    "$($_.OrderDate)" -notmatch "^\d{4}-\d{2}-\d{2}$"
  }
)
if ($invalid.Count -gt 0) {
  throw "Validation failed: invalid row(s) after outlier corrections."
}

$rows | Export-Csv -LiteralPath $FinalCsvPath -NoTypeInformation -Encoding UTF8

$summary = [ordered]@{
  generated_at_utc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  final_csv = $FinalCsvPath
  requested_corrections = $corrections.Count
  applied_corrections = $changed.Count
  missing_targets = $missing.Count
  duplicate_box_ids_after = $duplicates.Count
  invalid_rows_after = $invalid.Count
  changed_rows = $changed
  missing_rows = $missing
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SummaryJsonPath -Encoding UTF8

Write-Host "Outlier corrections applied."
Write-Host "Applied: $($changed.Count)"
Write-Host "Missing: $($missing.Count)"
