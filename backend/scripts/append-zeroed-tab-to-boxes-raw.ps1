param(
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$RunDir = "",
  [string]$BaseResolvedCsvPath = "",
  [string]$ZeroedCandidatesCsvPath = "",
  [string]$OutputCombinedCsvPath = "",
  [string]$OutputAppendedCsvPath = "",
  [string]$OutputSkippedCsvPath = "",
  [string]$OutputSummaryJsonPath = ""
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

if ([string]::IsNullOrWhiteSpace($BaseResolvedCsvPath)) {
  $BaseResolvedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_resolved_with_widths.csv"
}
if ([string]::IsNullOrWhiteSpace($ZeroedCandidatesCsvPath)) {
  $ZeroedCandidatesCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/zeroed_candidates_unique_last_occurrence_widths_defaulted.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputCombinedCsvPath)) {
  $OutputCombinedCsvPath = Join-Path -Path $RunDir -ChildPath "boxes_raw_final_with_zeroed.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputAppendedCsvPath)) {
  $OutputAppendedCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/zeroed_rows_appended.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputSkippedCsvPath)) {
  $OutputSkippedCsvPath = Join-Path -Path $RunDir -ChildPath "zeroed/zeroed_rows_skipped.csv"
}
if ([string]::IsNullOrWhiteSpace($OutputSummaryJsonPath)) {
  $OutputSummaryJsonPath = Join-Path -Path $RunDir -ChildPath "zeroed/zeroed_append_summary.json"
}

if (-not (Test-Path -LiteralPath $BaseResolvedCsvPath)) {
  throw "Base resolved CSV not found: $BaseResolvedCsvPath"
}

if (-not (Test-Path -LiteralPath $ZeroedCandidatesCsvPath)) {
  throw "Zeroed candidates CSV not found: $ZeroedCandidatesCsvPath"
}

$outputDirs = @(
  (Split-Path -Path $OutputCombinedCsvPath -Parent),
  (Split-Path -Path $OutputAppendedCsvPath -Parent),
  (Split-Path -Path $OutputSkippedCsvPath -Parent),
  (Split-Path -Path $OutputSummaryJsonPath -Parent)
)
foreach ($dir in $outputDirs) {
  if ([string]::IsNullOrWhiteSpace($dir)) {
    continue
  }
  if (-not (Test-Path -LiteralPath $dir)) {
    [void](New-Item -Path $dir -ItemType Directory -Force)
  }
}

function Normalize-Text {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  $upper = $Value.ToUpperInvariant().Trim()
  $clean = [regex]::Replace($upper, "[^A-Z0-9]+", " ")
  return [regex]::Replace($clean, "\s+", " ").Trim()
}

function Canonicalize-ManufacturerName {
  param([AllowNull()][string]$Value)

  $normalized = "$Value".Trim()
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    return ""
  }

  $collapsed = [regex]::Replace($normalized, "\s+", " ")
  switch ($collapsed.ToUpperInvariant()) {
    "3M" { return "3M Solar" }
    "FASARA" { return "3M Fasara" }
    "3M FASARA" { return "3M Fasara" }
    "AVERY" { return "Avery Dennison" }
    "SOLAR GUARD" { return "Solar Gard" }
    default { return $collapsed }
  }
}

function Parse-FilmNameFromDescription {
  param(
    [string]$Description,
    [string]$Width
  )

  $descriptionText = "$Description".Trim()
  if ([string]::IsNullOrWhiteSpace($descriptionText)) {
    return ""
  }

  $idMatch = [regex]::Match($descriptionText, "^[A-Za-z0-9]{2,12}\s*-\s*(?<rest>.+)$")
  $rest = if ($idMatch.Success) { $idMatch.Groups["rest"].Value } else { $descriptionText }
  $rest = [regex]::Replace($rest.Trim(), "\s+", " ")

  if (-not [string]::IsNullOrWhiteSpace($Width)) {
    $escaped = [regex]::Escape($Width.Trim())
    $rest = [regex]::Replace($rest, "(?i)\b$escaped\s*(?:""|IN(?:CH(?:ES)?)?)\s*$", "")
    $rest = [regex]::Replace($rest, "(?i)\b$escaped\s*$", "")
  }

  return [regex]::Replace($rest.Trim(" ", "-", ","), "\s+", " ")
}

function Get-TopManufacturer {
  param([hashtable]$Counts)

  if ($null -eq $Counts -or $Counts.Keys.Count -eq 0) {
    return $null
  }

  $ranked = @(
    $Counts.GetEnumerator() |
    Sort-Object -Property @(
      @{ Expression = "Value"; Descending = $true },
      @{ Expression = "Name"; Descending = $false }
    )
  )
  $top = $ranked[0]
  $secondCount = if ($ranked.Count -gt 1) { [int]$ranked[1].Value } else { -1 }

  return [pscustomobject]@{
    Manufacturer = [string]$top.Name
    TopCount = [int]$top.Value
    HasTie = ($ranked.Count -gt 1 -and [int]$top.Value -eq $secondCount)
  }
}

function Infer-ManufacturerFromKeywords {
  param(
    [string]$FilmName
  )

  $filmUpper = Normalize-Text -Value $FilmName
  if ([string]::IsNullOrWhiteSpace($filmUpper)) {
    return [pscustomobject]@{
      Manufacturer = "Vinyl"
      Source = "default_vinyl_empty_film"
    }
  }

  $is3m = $filmUpper -match "(^| )3M( |$)"
  $hasDiNocCue = $filmUpper -match "DI NOC|DIOC|(^| )NU[ -]"
  $hasFasaraCue = $filmUpper -match "FASARA|(^| )SH2|(^| )FGSW|(^| )FNCR|(^| )MACR|(^| )MAMM|(^| )MLCR|(^| )EMOS|(^| )EMLA|(^| )EMCH|(^| )CHMAL|(^| )HLMA|(^| )FGLS|(^| )FGLU|(^| )FGMR|(^| )FGSB|(^| )BKOP|(^| )MAOW|(^| )LAUSANNE|(^| )MILANO|(^| )LEISE|(^| )LUCE|(^| )OSLO|(^| )SAN MARINO"
  $hasSecurityCue = $filmUpper -match "MADICO|SAFETY|SAFETYSHIELD|S800|ULTRAS800|ULTRA S800|(^| )S140( |$)|(^| )S 140( |$)|(^| )S70( |$)|(^| )S 70( |$)|AG 4|ANTI GRAFFITI|14 MIL|7 MIL|4 MIL|SH14|SH7|SH4|SCLAR|(^| )S600( |$)"
  $hasSolarGuardCue = $filmUpper -match "(^| )SG( |$)|SOLAR GARD|TRUEVUE|SLATE|STERLING|PANAROMA"
  $hasAveryCue = $filmUpper -match "AVERY|(^| )AD( |$)|TITAN|R32311|ELITE|VELA|(^| )HT( |$)"
  $hasSolyxCue = $filmUpper -match "SOLYX|(^| )SX[0-9A-Z-]*"
  $hasLlumarCue = $filmUpper -match "LLUMAR|VISTA|NHE|N1050|(^| )V45( |$)|(^| )V28( |$)|(^| )V51( |$)|(^| )VS( |$)|(^| )R35( |$)|(^| )TH( |$)"
  $hasAswfCue = $filmUpper -match "ASWF|V KOOL|VKOOL|VK 70|VK 40"
  $hasVinylCue = $filmUpper -match "ORACAL|FELLERS|PERF|SCOTCHCAL|ELECTROCUT|DURANODIC|(^| )651( |$)|(^| )751( |$)|(^| )8500( |$)|(^| )951( |$)|VINYL|CASPER|CLOAKING|BARCODE|TRAFFIC|BRUSHED|DOW|CAULK|SILICONE"
  $has3mSolarCue = $filmUpper -match "(^| )PRX?( |$)|PRESTIGE|CERAMIC|(^| )PR 20( |$)|(^| )PR 40( |$)|(^| )PR 50( |$)|(^| )PR 70( |$)"

  if ($hasSolyxCue) {
    return [pscustomobject]@{ Manufacturer = "Solyx"; Source = "keyword_solyx" }
  }
  if ($hasLlumarCue) {
    return [pscustomobject]@{ Manufacturer = "Llumar"; Source = "keyword_llumar" }
  }
  if ($hasAswfCue) {
    return [pscustomobject]@{ Manufacturer = "ASWFVKOOL"; Source = "keyword_aswfvkool" }
  }
  if ($hasAveryCue) {
    return [pscustomobject]@{ Manufacturer = "Avery Dennison"; Source = "keyword_avery" }
  }
  if ($hasSolarGuardCue) {
    return [pscustomobject]@{ Manufacturer = "Solar Gard"; Source = "keyword_solar_guard" }
  }
  if ($hasDiNocCue) {
    return [pscustomobject]@{ Manufacturer = "Di-Noc"; Source = "keyword_di_noc" }
  }
  if ($hasVinylCue -and -not $is3m) {
    return [pscustomobject]@{ Manufacturer = "Vinyl"; Source = "keyword_vinyl" }
  }
  if ($hasSecurityCue) {
    return [pscustomobject]@{ Manufacturer = "Security"; Source = "keyword_security" }
  }
  if ($hasFasaraCue) {
    return [pscustomobject]@{ Manufacturer = "3M Fasara"; Source = "keyword_fasara" }
  }
  if ($is3m -and $has3mSolarCue) {
    return [pscustomobject]@{ Manufacturer = "3M Solar"; Source = "keyword_3m_solar" }
  }
  if ($is3m) {
    return [pscustomobject]@{ Manufacturer = "3M Solar"; Source = "keyword_3m_default" }
  }
  if ($hasVinylCue) {
    return [pscustomobject]@{ Manufacturer = "Vinyl"; Source = "keyword_vinyl" }
  }

  return [pscustomobject]@{
    Manufacturer = "Vinyl"
    Source = "default_vinyl"
  }
}

function Resolve-Manufacturer {
  param(
    [string]$FilmName,
    [string]$Width,
    [hashtable]$FilmWidthIndex,
    [hashtable]$FilmIndex
  )

  $filmKey = Normalize-Text -Value $FilmName
  $widthText = "$Width".Trim()

  if (-not [string]::IsNullOrWhiteSpace($filmKey) -and -not [string]::IsNullOrWhiteSpace($widthText)) {
    $exactKey = "$filmKey|$widthText"
    if ($FilmWidthIndex.ContainsKey($exactKey)) {
      $top = Get-TopManufacturer -Counts $FilmWidthIndex[$exactKey]
      if ($null -ne $top) {
        if (-not $top.HasTie) {
          return [pscustomobject]@{
            Manufacturer = $top.Manufacturer
            Source = "lookup_film_width"
          }
        }
      }
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($filmKey) -and $FilmIndex.ContainsKey($filmKey)) {
    $topByFilm = Get-TopManufacturer -Counts $FilmIndex[$filmKey]
    if ($null -ne $topByFilm) {
      if (-not $topByFilm.HasTie) {
        return [pscustomobject]@{
          Manufacturer = $topByFilm.Manufacturer
          Source = "lookup_film"
        }
      }
    }
  }

  return Infer-ManufacturerFromKeywords -FilmName $FilmName
}

function Test-DateYmd {
  param([string]$Value)
  return "$Value" -match "^\d{4}-\d{2}-\d{2}$"
}

function Normalize-Lot {
  param([string]$LotValue)
  $lot = "$LotValue".Trim()
  if ([string]::IsNullOrWhiteSpace($lot)) {
    return ""
  }

  $upper = $lot.ToUpperInvariant()
  if ($upper -in @("NA", "N/A", "NONE", "NULL")) {
    return ""
  }

  return $lot
}

function New-ZeroedBoxesRawRow {
  param(
    [string]$BoxId,
    [string]$Manufacturer,
    [string]$FilmName,
    [int]$Width,
    [string]$LotRun,
    [string]$ZeroedDate,
    [string]$RowNumber,
    [string]$DateMethod,
    [string]$ManufacturerSource,
    [string]$RawDescription
  )

  $canonicalManufacturer = Canonicalize-ManufacturerName -Value $Manufacturer
  $filmKey = "$($canonicalManufacturer.ToUpperInvariant())|$($FilmName.ToUpperInvariant())"
  $notes = "SourceSheet=Zeroed Out Inventory; SourceRow=$RowNumber; DateMethod=$DateMethod; ManufacturerSource=$ManufacturerSource; RawDescription=$RawDescription"

  return [pscustomobject][ordered]@{
    BoxID = $BoxId
    Manufacturer = $canonicalManufacturer
    FilmName = $FilmName
    WidthIn = "$Width"
    InitialFeet = "0"
    FeetAvailable = "0"
    LotRun = $LotRun
    Status = "ZEROED"
    OrderDate = $ZeroedDate
    ReceivedDate = $ZeroedDate
    InitialWeightLbs = ""
    LastRollWeightLbs = ""
    LastWeighedDate = ""
    FilmKey = $filmKey
    CoreType = ""
    CoreWeightLbs = ""
    LfWeightLbsPerFt = ""
    PricePerLf = ""
    PurchaseCost = ""
    Notes = $notes
    HasEverBeenCheckedOut = "false"
    LastCheckoutJob = ""
    LastCheckoutDate = ""
    ZeroedDate = $ZeroedDate
    ZeroedReason = "Imported from Zeroed Out Inventory tab"
    ZeroedBy = "migration"
  }
}

$baseRows = @(Import-Csv -LiteralPath $BaseResolvedCsvPath)
$zeroRows = @(Import-Csv -LiteralPath $ZeroedCandidatesCsvPath)

if ($baseRows.Count -eq 0) {
  throw "Base CSV has no rows: $BaseResolvedCsvPath"
}

$requiredBaseColumns = @(
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

$baseHeader = @($baseRows[0].PSObject.Properties.Name)
foreach ($col in $requiredBaseColumns) {
  if (-not ($baseHeader -contains $col)) {
    throw "Base CSV missing required column: $col"
  }
}

$existingIds = @{}
foreach ($row in $baseRows) {
  $id = "$($row.BoxID)".Trim()
  if (-not [string]::IsNullOrWhiteSpace($id)) {
    $existingIds[$id] = $true
  }
}

$filmWidthIndex = @{}
$filmIndex = @{}
foreach ($row in $baseRows) {
  $film = Normalize-Text -Value $row.FilmName
  $width = "$($row.WidthIn)".Trim()
  $manufacturer = Canonicalize-ManufacturerName -Value $row.Manufacturer

  if ([string]::IsNullOrWhiteSpace($film) -or [string]::IsNullOrWhiteSpace($manufacturer)) {
    continue
  }

  if (-not $filmIndex.ContainsKey($film)) {
    $filmIndex[$film] = @{}
  }
  if (-not $filmIndex[$film].ContainsKey($manufacturer)) {
    $filmIndex[$film][$manufacturer] = 0
  }
  $filmIndex[$film][$manufacturer] += 1

  if ([string]::IsNullOrWhiteSpace($width)) {
    continue
  }

  $filmWidthKey = "$film|$width"
  if (-not $filmWidthIndex.ContainsKey($filmWidthKey)) {
    $filmWidthIndex[$filmWidthKey] = @{}
  }
  if (-not $filmWidthIndex[$filmWidthKey].ContainsKey($manufacturer)) {
    $filmWidthIndex[$filmWidthKey][$manufacturer] = 0
  }
  $filmWidthIndex[$filmWidthKey][$manufacturer] += 1
}

$appendedRows = New-Object System.Collections.Generic.List[object]
$skippedRows = New-Object System.Collections.Generic.List[object]
$inferenceSourceCounts = @{}

foreach ($zero in $zeroRows) {
  $boxId = "$($zero.box_id)".Trim()
  if ([string]::IsNullOrWhiteSpace($boxId)) {
    $skippedRows.Add([pscustomobject]@{
        row_number = $zero.row_number
        box_id = ""
        reason = "missing_box_id"
        description = $zero.description
      })
    continue
  }

  if ($existingIds.ContainsKey($boxId)) {
    $skippedRows.Add([pscustomobject]@{
        row_number = $zero.row_number
        box_id = $boxId
        reason = "duplicate_box_id"
        description = $zero.description
      })
    continue
  }

  $widthParsed = 0
  if (-not [int]::TryParse("$($zero.width)".Trim(), [ref]$widthParsed) -or $widthParsed -le 0) {
    $skippedRows.Add([pscustomobject]@{
        row_number = $zero.row_number
        box_id = $boxId
        reason = "invalid_width"
        width = $zero.width
        description = $zero.description
      })
    continue
  }

  $zeroedDate = "$($zero.inferred_zeroed_date)".Trim()
  if (-not (Test-DateYmd -Value $zeroedDate)) {
    $skippedRows.Add([pscustomobject]@{
        row_number = $zero.row_number
        box_id = $boxId
        reason = "invalid_zeroed_date"
        inferred_zeroed_date = $zero.inferred_zeroed_date
        description = $zero.description
      })
    continue
  }

  $filmName = Parse-FilmNameFromDescription -Description $zero.description -Width "$widthParsed"
  if ([string]::IsNullOrWhiteSpace($filmName)) {
    $skippedRows.Add([pscustomobject]@{
        row_number = $zero.row_number
        box_id = $boxId
        reason = "film_name_parse_failed"
        description = $zero.description
      })
    continue
  }

  $manufacturerResolution = Resolve-Manufacturer -FilmName $filmName -Width "$widthParsed" -FilmWidthIndex $filmWidthIndex -FilmIndex $filmIndex
  $manufacturer = Canonicalize-ManufacturerName -Value $manufacturerResolution.Manufacturer
  $manufacturerSource = "$($manufacturerResolution.Source)".Trim()

  if ([string]::IsNullOrWhiteSpace($manufacturer)) {
    $skippedRows.Add([pscustomobject]@{
        row_number = $zero.row_number
        box_id = $boxId
        reason = "manufacturer_resolution_failed"
        film_name = $filmName
        description = $zero.description
      })
    continue
  }

  if (-not $inferenceSourceCounts.ContainsKey($manufacturerSource)) {
    $inferenceSourceCounts[$manufacturerSource] = 0
  }
  $inferenceSourceCounts[$manufacturerSource] += 1

  $lotRun = Normalize-Lot -LotValue $zero.lot
  $row = New-ZeroedBoxesRawRow `
    -BoxId $boxId `
    -Manufacturer $manufacturer `
    -FilmName $filmName `
    -Width $widthParsed `
    -LotRun $lotRun `
    -ZeroedDate $zeroedDate `
    -RowNumber "$($zero.row_number)" `
    -DateMethod "$($zero.date_resolution_method)" `
    -ManufacturerSource $manufacturerSource `
    -RawDescription "$($zero.description)"

  $appendedRows.Add($row)
  $existingIds[$boxId] = $true
}

$combinedRows = @($baseRows + $appendedRows)

$duplicates = @($combinedRows | Group-Object BoxID | Where-Object { $_.Count -gt 1 })
if ($duplicates.Count -gt 0) {
  throw "Validation failed: duplicate BoxID values found in combined output."
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
  throw "Validation failed: invalid row(s) exist in combined output."
}

$combinedRows | Export-Csv -LiteralPath $OutputCombinedCsvPath -NoTypeInformation -Encoding UTF8
$appendedRows | Export-Csv -LiteralPath $OutputAppendedCsvPath -NoTypeInformation -Encoding UTF8
$skippedRows | Export-Csv -LiteralPath $OutputSkippedCsvPath -NoTypeInformation -Encoding UTF8

$manufacturerDistribution = @($appendedRows | Group-Object Manufacturer | Sort-Object Count -Descending | ForEach-Object {
    [pscustomobject]@{
      manufacturer = $_.Name
      rows = $_.Count
    }
  })

$summary = [ordered]@{
  generated_at_utc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  profile = $Profile
  run_dir = $RunDir
  base_csv = $BaseResolvedCsvPath
  zeroed_candidates_csv = $ZeroedCandidatesCsvPath
  output_combined_csv = $OutputCombinedCsvPath
  output_appended_csv = $OutputAppendedCsvPath
  output_skipped_csv = $OutputSkippedCsvPath
  base_rows = $baseRows.Count
  zeroed_candidate_rows = $zeroRows.Count
  appended_rows = $appendedRows.Count
  skipped_rows = $skippedRows.Count
  combined_rows = $combinedRows.Count
  duplicate_box_ids_after_merge = $duplicates.Count
  invalid_rows_after_merge = $invalidRows.Count
  appended_status_breakdown = [ordered]@{
    ZEROED = ($appendedRows | Where-Object { $_.Status -eq "ZEROED" }).Count
  }
  appended_manufacturer_distribution = $manufacturerDistribution
  manufacturer_inference_sources = $inferenceSourceCounts
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputSummaryJsonPath -Encoding UTF8

Write-Host "Zeroed tab append completed."
Write-Host "Base rows: $($baseRows.Count)"
Write-Host "Zeroed candidates: $($zeroRows.Count)"
Write-Host "Appended: $($appendedRows.Count)"
Write-Host "Skipped: $($skippedRows.Count)"
Write-Host "Combined rows: $($combinedRows.Count)"
