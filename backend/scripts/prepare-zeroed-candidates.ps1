param(
  [ValidateSet("IL", "MS")]
  [string]$Profile = "IL",
  [string]$WorkbookPath = "",
  [string]$RunDir = "",
  [string]$DefaultPrefix = "",
  [string]$LegacyMPrefix = "",
  [string]$ZeroedSheetName = "Zeroed Out Inventory",
  [string]$FallbackZeroedDate = "",
  [int]$DefaultWidth = 60,
  [switch]$AllowOptionalHyphenDescriptions
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$profileConfigs = @{
  IL = [pscustomobject]@{
    default_workbook = "C:\Users\Rober\Downloads\IL Assigned Inventory.xlsx"
    run_dir = "backend/migration-dry-runs/il-assigned"
    default_prefix = "IL1"
    legacy_m_prefix = "MS1"
    allow_optional_hyphen = $false
  }
  MS = [pscustomobject]@{
    default_workbook = "C:\Users\Rober\Downloads\MS Inventory.xlsx"
    run_dir = "backend/migration-dry-runs/ms-inventory"
    default_prefix = "MS1"
    legacy_m_prefix = "MS1"
    allow_optional_hyphen = $true
  }
}

$config = $profileConfigs[$Profile]
if ($null -eq $config) {
  throw "Unsupported profile: $Profile"
}

if ([string]::IsNullOrWhiteSpace($WorkbookPath)) {
  $WorkbookPath = [string]$config.default_workbook
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

$allowOptionalHyphen = [bool]$config.allow_optional_hyphen
if ($PSBoundParameters.ContainsKey("AllowOptionalHyphenDescriptions")) {
  $allowOptionalHyphen = $AllowOptionalHyphenDescriptions.IsPresent
}

if (-not (Test-Path -LiteralPath $WorkbookPath)) {
  throw "Workbook not found: $WorkbookPath"
}

$runPath = Join-Path -Path (Get-Location) -ChildPath $RunDir
$zeroedDir = Join-Path -Path $runPath -ChildPath "zeroed"
if (-not (Test-Path -LiteralPath $zeroedDir)) {
  [void](New-Item -Path $zeroedDir -ItemType Directory -Force)
}

$uniqueCandidatesPath = Join-Path -Path $zeroedDir -ChildPath "zeroed_candidates_unique_last_occurrence.csv"
$timelinePath = Join-Path -Path $zeroedDir -ChildPath "zeroed_date_inference_timeline.csv"
$dateSummaryPath = Join-Path -Path $zeroedDir -ChildPath "zeroed_date_inference_summary.json"
$widthDefaultedPath = Join-Path -Path $zeroedDir -ChildPath "zeroed_candidates_unique_last_occurrence_widths_defaulted.csv"
$widthSummaryPath = Join-Path -Path $zeroedDir -ChildPath "zeroed_width_default_summary.json"

foreach ($path in @($uniqueCandidatesPath, $timelinePath, $dateSummaryPath, $widthDefaultedPath, $widthSummaryPath)) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
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
  param([string]$CellRef)

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

function Parse-ZeroedDescription {
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
      IdToken = ""
      BoxId = ""
      WidthIn = $null
    }
  }

  $match = [regex]::Match($description, "^(?<id>[A-Za-z]{2}[1-9][0-9]*-[A-Za-z0-9]+)\s*-\s*(?<rest>.+)$")
  if (-not $match.Success) {
    $match = [regex]::Match($description, "^(?<id>[A-Za-z0-9]{2,16})\s*-\s*(?<rest>.+)$")
  }
  if (-not $match.Success -and $AllowOptionalHyphenDescriptions) {
    $match = [regex]::Match($description, "^(?<id>[A-Za-z0-9]{2,16})\s+(?<rest>.+)$")
  }
  if (-not $match.Success) {
    return [pscustomobject]@{
      Success = $false
      IdToken = ""
      BoxId = ""
      WidthIn = $null
    }
  }

  $idToken = $match.Groups["id"].Value.ToUpperInvariant()
  $rest = [regex]::Replace($match.Groups["rest"].Value.Trim(), "\s+", " ")
  $widthMatch = [regex]::Match($rest, '(?<width>\d{2,3})\s*(?:"|IN(?:CH(?:ES)?)?)\s*$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $widthMatch.Success) {
    $widthMatch = [regex]::Match($rest, "(?<width>\d{2,3})\s*$")
  }

  $width = $null
  if ($widthMatch.Success) {
    $parsedWidth = [int]$widthMatch.Groups["width"].Value
    if ($parsedWidth -gt 0) {
      $width = $parsedWidth
    }
  }

  $boxId = Build-CanonicalBoxIdFromIdToken -IdToken $idToken -DefaultPrefix $DefaultPrefix -LegacyMPrefix $LegacyMPrefix

  return [pscustomobject]@{
    Success = -not [string]::IsNullOrWhiteSpace($boxId)
    IdToken = $idToken
    BoxId = $boxId
    WidthIn = $width
  }
}

function Convert-ExcelSerialToDateYmd {
  param([double]$Serial)

  if ($Serial -lt 30000 -or $Serial -gt 70000) {
    return $null
  }

  try {
    $base = [datetime]::new(1899, 12, 30)
    return $base.AddDays($Serial).ToString("yyyy-MM-dd")
  } catch {
    return $null
  }
}

function Parse-DateFromText {
  param([string]$RawValue)

  if ([string]::IsNullOrWhiteSpace($RawValue)) {
    return $null
  }

  $value = $RawValue.Trim()

  $match = [regex]::Match($value, "(?<m>\d{1,2})/(?<d>\d{1,2})/(?<y>\d{2,4})")
  if ($match.Success) {
    $month = [int]$match.Groups["m"].Value
    $day = [int]$match.Groups["d"].Value
    $year = [int]$match.Groups["y"].Value
    if ($year -lt 100) {
      $year += 2000
    }

    try {
      return ([datetime]::new($year, $month, $day)).ToString("yyyy-MM-dd")
    } catch {
      return $null
    }
  }

  $monthYear = [regex]::Match(
    $value,
    "(?i)(?<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*,?\s*(?<day>\d{1,2})?\s*,?\s*(?<year>\d{4})"
  )
  if ($monthYear.Success) {
    $monthToken = $monthYear.Groups["month"].Value.ToLowerInvariant()
    $month = 0
    switch -Regex ($monthToken) {
      "^jan" { $month = 1 }
      "^feb" { $month = 2 }
      "^mar" { $month = 3 }
      "^apr" { $month = 4 }
      "^may" { $month = 5 }
      "^jun" { $month = 6 }
      "^jul" { $month = 7 }
      "^aug" { $month = 8 }
      "^sep" { $month = 9 }
      "^oct" { $month = 10 }
      "^nov" { $month = 11 }
      "^dec" { $month = 12 }
    }

    if ($month -gt 0) {
      $year = [int]$monthYear.Groups["year"].Value
      $dayGroup = "$($monthYear.Groups["day"].Value)".Trim()
      $day = [DateTime]::DaysInMonth($year, $month)
      if (-not [string]::IsNullOrWhiteSpace($dayGroup)) {
        $day = [int]$dayGroup
      }

      try {
        return ([datetime]::new($year, $month, $day)).ToString("yyyy-MM-dd")
      } catch {
        return $null
      }
    }
  }

  $numeric = 0.0
  $isNumeric = [double]::TryParse(
    $value,
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [ref]$numeric
  )
  if ($isNumeric) {
    return Convert-ExcelSerialToDateYmd -Serial $numeric
  }

  return $null
}

function Resolve-KnownZeroedDateFromRow {
  param([hashtable]$ValueMap)

  foreach ($key in ($ValueMap.Keys | Sort-Object)) {
    $candidate = Parse-DateFromText -RawValue ([string]$ValueMap[$key])
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      return $candidate
    }
  }

  return ""
}

function Resolve-InferredDate {
  param(
    [int]$RowNumber,
    [string]$KnownDate,
    [object[]]$KnownEntries,
    [string]$FallbackDate
  )

  if (-not [string]::IsNullOrWhiteSpace($KnownDate)) {
    return [pscustomobject]@{
      Date = $KnownDate
      Method = "original_known"
    }
  }

  $previous = $KnownEntries |
  Where-Object { [int]$_.row_number -lt $RowNumber } |
  Sort-Object @{ Expression = { [int]$_.row_number }; Descending = $true } |
  Select-Object -First 1

  $next = $KnownEntries |
  Where-Object { [int]$_.row_number -gt $RowNumber } |
  Sort-Object @{ Expression = { [int]$_.row_number }; Descending = $false } |
  Select-Object -First 1

  if ($null -ne $previous -and $null -ne $next) {
    $prevDate = [datetime]::ParseExact($previous.original_known_date, "yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
    $nextDate = [datetime]::ParseExact($next.original_known_date, "yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)

    $distance = [double]([int]$next.row_number - [int]$previous.row_number)
    if ($distance -le 0) {
      return [pscustomobject]@{
        Date = $previous.original_known_date
        Method = "forward_fill_from_previous"
      }
    }

    $ratio = ([double]($RowNumber - [int]$previous.row_number)) / $distance
    $dayDelta = ($nextDate - $prevDate).TotalDays
    $offsetDays = [math]::Round($dayDelta * $ratio)
    $inferred = $prevDate.AddDays($offsetDays).ToString("yyyy-MM-dd")

    return [pscustomobject]@{
      Date = $inferred
      Method = "interpolated_between_known"
    }
  }

  if ($null -ne $previous) {
    return [pscustomobject]@{
      Date = $previous.original_known_date
      Method = "forward_fill_from_previous"
    }
  }

  if ($null -ne $next) {
    return [pscustomobject]@{
      Date = $next.original_known_date
      Method = "back_fill_from_next"
    }
  }

  return [pscustomobject]@{
    Date = $FallbackDate
    Method = "default_fallback_date"
  }
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($WorkbookPath)
try {
  $sharedStrings = @()
  $sharedXmlText = Get-ZipEntryText -Archive $archive -EntryPath "xl/sharedStrings.xml"
  if ($sharedXmlText) {
    [xml]$sharedXml = $sharedXmlText
    $nodes = $sharedXml.SelectNodes('/*[local-name()="sst"]/*[local-name()="si"]')
    foreach ($node in $nodes) {
      $parts = @()
      $textNodes = $node.SelectNodes('.//*[local-name()="t"]')
      foreach ($t in $textNodes) {
        $parts += [string]$t.InnerText
      }
      $sharedStrings += ($parts -join "")
    }
  }

  [xml]$workbookXml = Get-ZipEntryText -Archive $archive -EntryPath "xl/workbook.xml"
  [xml]$relsXml = Get-ZipEntryText -Archive $archive -EntryPath "xl/_rels/workbook.xml.rels"
  if (-not $workbookXml -or -not $relsXml) {
    throw "Unable to read workbook metadata from $WorkbookPath"
  }

  $relationshipMap = @{}
  $relNodes = $relsXml.SelectNodes('/*[local-name()="Relationships"]/*[local-name()="Relationship"]')
  foreach ($rel in $relNodes) {
    $relationshipMap[[string]$rel.GetAttribute("Id")] = [string]$rel.GetAttribute("Target")
  }

  $sheetNodeMap = @{}
  $workbookSheetNodes = $workbookXml.SelectNodes('/*[local-name()="workbook"]/*[local-name()="sheets"]/*[local-name()="sheet"]')
  foreach ($sheetNodeEntry in $workbookSheetNodes) {
    $sheetNameRaw = [string]$sheetNodeEntry.GetAttribute("name")
    $sheetName = $sheetNameRaw.Trim()
    $relationshipId = [string]$sheetNodeEntry.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
    $target = $relationshipMap[$relationshipId]
    if ([string]::IsNullOrWhiteSpace($target)) {
      continue
    }
    if (-not $target.StartsWith("xl/")) {
      $target = "xl/" + $target.TrimStart("/")
    }

    $sheetNodeMap[$sheetName] = [pscustomobject]@{
      Name = $sheetName
      Target = $target
    }
  }

  $sheetNode = $sheetNodeMap[$ZeroedSheetName]
  if (-not $sheetNode) {
    throw "Worksheet '$ZeroedSheetName' not found in workbook"
  }

  $fallbackDate = "$FallbackZeroedDate".Trim()
  if (-not [string]::IsNullOrWhiteSpace($fallbackDate) -and $fallbackDate -notmatch "^\d{4}-\d{2}-\d{2}$") {
    throw "FallbackZeroedDate must be YYYY-MM-DD when provided."
  }

  if ([string]::IsNullOrWhiteSpace($fallbackDate)) {
    $headerDates = New-Object System.Collections.Generic.List[datetime]
    foreach ($entry in $sheetNodeMap.Values) {
      if ($entry.Name -eq $ZeroedSheetName) {
        continue
      }

      [xml]$candidateSheetXml = Get-ZipEntryText -Archive $archive -EntryPath $entry.Target
      if (-not $candidateSheetXml) {
        continue
      }

      $headerRow = $candidateSheetXml.SelectSingleNode('/*[local-name()="worksheet"]/*[local-name()="sheetData"]/*[local-name()="row"][@r="1"]')
      if (-not $headerRow) {
        continue
      }

      $headerValueMap = Get-RowValueMap -Row $headerRow -SharedStrings $sharedStrings
      foreach ($key in $headerValueMap.Keys) {
        $candidateDate = Parse-DateFromText -RawValue ([string]$headerValueMap[$key])
        if ([string]::IsNullOrWhiteSpace($candidateDate)) {
          continue
        }

        $parsedDate = [datetime]::MinValue
        if ([datetime]::TryParseExact(
            $candidateDate,
            "yyyy-MM-dd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$parsedDate
          )) {
          $headerDates.Add($parsedDate)
        }
      }
    }

    if ($headerDates.Count -gt 0) {
      $maxDate = ($headerDates | Sort-Object -Descending | Select-Object -First 1)
      $fallbackDate = $maxDate.ToString("yyyy-MM-dd")
    }
  }

  if ([string]::IsNullOrWhiteSpace($fallbackDate)) {
    $fallbackDate = (Get-Date).ToString("yyyy-MM-dd")
  }

  [xml]$sheetXml = Get-ZipEntryText -Archive $archive -EntryPath $sheetNode.Target
  if (-not $sheetXml) {
    throw "Unable to read worksheet XML for '$ZeroedSheetName'"
  }

  $rows = $sheetXml.SelectNodes('/*[local-name()="worksheet"]/*[local-name()="sheetData"]/*[local-name()="row"]')
  if (-not $rows -or $rows.Count -eq 0) {
    throw "Worksheet '$ZeroedSheetName' has no rows"
  }

  $allParsedRows = New-Object System.Collections.Generic.List[object]
  foreach ($row in ($rows | Where-Object { [int]$_.GetAttribute("r") -gt 1 })) {
    $rowNumber = [int]$row.GetAttribute("r")
    $valueMap = Get-RowValueMap -Row $row -SharedStrings $sharedStrings

    $description = ""
    if ($valueMap.ContainsKey(0)) {
      $description = [string]$valueMap[0]
    }

    $lot = ""
    if ($valueMap.ContainsKey(1)) {
      $lot = [string]$valueMap[1]
    }

    $rawZeroedDate = ""
    if ($valueMap.ContainsKey(2)) {
      $rawZeroedDate = [string]$valueMap[2]
    }

    if ([string]::IsNullOrWhiteSpace($description) -and [string]::IsNullOrWhiteSpace($lot) -and [string]::IsNullOrWhiteSpace($rawZeroedDate)) {
      continue
    }

    $parsed = Parse-ZeroedDescription `
      -RawDescription $description `
      -DefaultPrefix $DefaultPrefix `
      -LegacyMPrefix $LegacyMPrefix `
      -AllowOptionalHyphenDescriptions $allowOptionalHyphen

    if (-not $parsed.Success) {
      continue
    }

    $knownDate = Resolve-KnownZeroedDateFromRow -ValueMap $valueMap

    $allParsedRows.Add([pscustomobject][ordered]@{
        row_number = $rowNumber
        description = "$description".Trim()
        lot = "$lot".Trim()
        box_id = "$($parsed.BoxId)".Trim()
        id_token = "$($parsed.IdToken)".Trim()
        width = if ($null -eq $parsed.WidthIn) { "" } else { [string]$parsed.WidthIn }
        raw_zeroed_date = "$rawZeroedDate".Trim()
        original_known_date = $knownDate
      })
  }

  $lastOccurrenceByBoxId = @{}
  foreach ($candidate in $allParsedRows) {
    $boxId = "$($candidate.box_id)".Trim()
    if ([string]::IsNullOrWhiteSpace($boxId)) {
      continue
    }

    if (-not $lastOccurrenceByBoxId.ContainsKey($boxId)) {
      $lastOccurrenceByBoxId[$boxId] = $candidate
      continue
    }

    if ([int]$candidate.row_number -ge [int]$lastOccurrenceByBoxId[$boxId].row_number) {
      $lastOccurrenceByBoxId[$boxId] = $candidate
    }
  }

  $uniqueCandidates = @($lastOccurrenceByBoxId.Values | Sort-Object @{ Expression = { [int]$_.row_number }; Descending = $false })

  $knownEntries = @($uniqueCandidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_.original_known_date) })

  $dateMethodCounts = @{}
  $enrichedRows = New-Object System.Collections.Generic.List[object]
  $timelineRows = New-Object System.Collections.Generic.List[object]

  foreach ($row in $uniqueCandidates) {
    $resolution = Resolve-InferredDate `
      -RowNumber ([int]$row.row_number) `
      -KnownDate "$($row.original_known_date)" `
      -KnownEntries $knownEntries `
      -FallbackDate $fallbackDate

    if (-not $dateMethodCounts.ContainsKey($resolution.Method)) {
      $dateMethodCounts[$resolution.Method] = 0
    }
    $dateMethodCounts[$resolution.Method] = [int]$dateMethodCounts[$resolution.Method] + 1

    $enrichedRows.Add([pscustomobject][ordered]@{
        row_number = [string]$row.row_number
        description = "$($row.description)"
        lot = "$($row.lot)"
        box_id = "$($row.box_id)"
        id_token = "$($row.id_token)"
        width = "$($row.width)"
        raw_zeroed_date = "$($row.raw_zeroed_date)"
        original_known_date = "$($row.original_known_date)"
        inferred_zeroed_date = "$($resolution.Date)"
        date_resolution_method = "$($resolution.Method)"
      })

    $timelineRows.Add([pscustomobject][ordered]@{
        row_number = [string]$row.row_number
        box_id = "$($row.box_id)"
        original_known_date = "$($row.original_known_date)"
        inferred_zeroed_date = "$($resolution.Date)"
        date_resolution_method = "$($resolution.Method)"
      })
  }

  $widthDefaultCount = 0
  $widthPreservedCount = 0
  $widthDefaultedRows = New-Object System.Collections.Generic.List[object]

  foreach ($row in $enrichedRows) {
    $width = 0
    $widthSource = "default_60"
    if ([int]::TryParse("$($row.width)", [ref]$width) -and $width -gt 0) {
      $widthSource = "parsed"
      $widthPreservedCount++
    } else {
      $width = $DefaultWidth
      $widthDefaultCount++
    }

    $widthDefaultedRows.Add([pscustomobject][ordered]@{
        row_number = "$($row.row_number)"
        description = "$($row.description)"
        lot = "$($row.lot)"
        box_id = "$($row.box_id)"
        id_token = "$($row.id_token)"
        width = [string]$width
        width_source = $widthSource
        raw_zeroed_date = "$($row.raw_zeroed_date)"
        original_known_date = "$($row.original_known_date)"
        inferred_zeroed_date = "$($row.inferred_zeroed_date)"
        date_resolution_method = "$($row.date_resolution_method)"
      })
  }

  $enrichedRows | Export-Csv -LiteralPath $uniqueCandidatesPath -NoTypeInformation -Encoding UTF8
  $timelineRows | Export-Csv -LiteralPath $timelinePath -NoTypeInformation -Encoding UTF8
  $widthDefaultedRows | Export-Csv -LiteralPath $widthDefaultedPath -NoTypeInformation -Encoding UTF8

  $dateSummary = [ordered]@{
    generated_at_utc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    profile = $Profile
    workbook_path = $WorkbookPath
    run_dir = $RunDir
    zeroed_sheet = $ZeroedSheetName
    total_zeroed_rows = $allParsedRows.Count
    candidate_rows_with_box_id = $allParsedRows.Count
    unique_candidate_rows = $enrichedRows.Count
    known_date_rows = $knownEntries.Count
    inferred_date_rows = (@($enrichedRows | Where-Object { $_.date_resolution_method -ne "original_known" })).Count
    fallback_date_used = $fallbackDate
    method_counts = @(
      $dateMethodCounts.GetEnumerator() |
      Sort-Object Name |
      ForEach-Object {
        [pscustomobject]@{
          method = $_.Name
          count = $_.Value
        }
      }
    )
    output_candidates_csv = $uniqueCandidatesPath
    output_timeline_csv = $timelinePath
  }
  $dateSummary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $dateSummaryPath -Encoding UTF8

  $widthSummary = [ordered]@{
    generated_at_utc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    profile = $Profile
    default_width = $DefaultWidth
    total_rows = $widthDefaultedRows.Count
    preserved_width_rows = $widthPreservedCount
    defaulted_width_rows = $widthDefaultCount
    output_width_defaulted_csv = $widthDefaultedPath
  }
  $widthSummary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $widthSummaryPath -Encoding UTF8

  Write-Host "Zeroed candidate prep complete."
  Write-Host "Profile:                $Profile"
  Write-Host "Parsed candidate rows:  $($allParsedRows.Count)"
  Write-Host "Unique by BoxID rows:   $($enrichedRows.Count)"
  Write-Host "Known date rows:        $($knownEntries.Count)"
  Write-Host "Defaulted width rows:   $widthDefaultCount"
  Write-Host "Artifacts:"
  Write-Host "  $uniqueCandidatesPath"
  Write-Host "  $widthDefaultedPath"
  Write-Host "  $timelinePath"
  Write-Host "  $dateSummaryPath"
  Write-Host "  $widthSummaryPath"
}
finally {
  $archive.Dispose()
}
