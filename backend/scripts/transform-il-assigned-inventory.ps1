param(
  [string]$WorkbookPath = "C:\Users\Rober\Downloads\IL Assigned Inventory.xlsx",
  [string]$OutputDir = "backend/migration-dry-runs/il-assigned"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$targetSheetNames = @(
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
    if ((Normalize-HeaderText -Value $Headers[$i]) -like "*lot*") {
      return $i
    }
  }

  return -1
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

function Parse-Description {
  param(
    [string]$RawDescription
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

  $idMatch = [regex]::Match($description, "^(?<id>[A-Za-z0-9]{2,12})\s*-\s*(?<rest>.+)$")
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

  $boxId = ""
  if ($idToken.StartsWith("M", [System.StringComparison]::OrdinalIgnoreCase)) {
    $boxId = $idToken
  } else {
    $boxId = "IL-$idToken"
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

$outputPath = Join-Path -Path (Get-Location) -ChildPath $OutputDir
if (-not (Test-Path -LiteralPath $outputPath)) {
  [void](New-Item -Path $outputPath -ItemType Directory -Force)
}

$boxesCsvPath = Join-Path -Path $outputPath -ChildPath "boxes_raw.csv"
$exceptionsCsvPath = Join-Path -Path $outputPath -ChildPath "boxes_exceptions.csv"
$collisionsCsvPath = Join-Path -Path $outputPath -ChildPath "id_collisions.csv"
$summaryJsonPath = Join-Path -Path $outputPath -ChildPath "summary.json"

foreach ($path in @($boxesCsvPath, $exceptionsCsvPath, $collisionsCsvPath, $summaryJsonPath)) {
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
  $seenBoxIds = @{}
  $warehouseCounts = @{ IL = 0; MS = 0 }
  $globalReasonCounts = @{}
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
    $inventoryDate = Get-InventoryDateFromHeaders -Headers $headers

    $sheetAccepted = 0
    $sheetSkipped = 0
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

      $parsed = Parse-Description -RawDescription $rawDescription
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

      $manufacturer = $sheetName
      $lotRun = "$rawLot".Trim()

      $boxesRow = New-BoxesRawRow -BoxId $candidateBoxId -Manufacturer $manufacturer -FilmName $parsed.FilmName -WidthIn $parsed.WidthIn -Feet $feet -LotRun $lotRun -InventoryDate $inventoryDate -SourceSheet $sheetName -SourceRow $rowNumber -RawDescription $rawDescription
      $boxesRows.Add($boxesRow)

      if ($candidateBoxId.StartsWith("M", [System.StringComparison]::OrdinalIgnoreCase)) {
        $warehouseCounts["MS"] = [int]$warehouseCounts["MS"] + 1
      } else {
        $warehouseCounts["IL"] = [int]$warehouseCounts["IL"] + 1
      }

      $sheetAccepted++
    }

    $perSheetSummary.Add([pscustomobject]@{
        sheet = $sheetName
        inventory_date = $inventoryDate
        quantity_column = if ($quantityColumnIndex -ge 0 -and $quantityColumnIndex -lt $headers.Count) { $headers[$quantityColumnIndex] } else { $null }
        lot_column = if ($lotColumnIndex -ge 0 -and $lotColumnIndex -lt $headers.Count) { $headers[$lotColumnIndex] } else { $null }
        accepted_rows = $sheetAccepted
        skipped_rows = $sheetSkipped
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

  $boxesRows | Select-Object $boxesRawColumns | Export-Csv -LiteralPath $boxesCsvPath -NoTypeInformation -Encoding UTF8
  $exceptionsRows | Export-Csv -LiteralPath $exceptionsCsvPath -NoTypeInformation -Encoding UTF8
  $collisionsRows | Export-Csv -LiteralPath $collisionsCsvPath -NoTypeInformation -Encoding UTF8

  $acceptedCount = $boxesRows.Count
  $skippedCount = $exceptionsRows.Count
  $collisionCount = $collisionsRows.Count

  $summary = [pscustomobject][ordered]@{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    workbook_path = $WorkbookPath
    output_dir = $outputPath
    totals = [pscustomobject][ordered]@{
      accepted_rows = $acceptedCount
      skipped_rows = $skippedCount
      collision_rows = $collisionCount
    }
    warehouse_counts = [pscustomobject][ordered]@{
      IL = [int]$warehouseCounts["IL"]
      MS = [int]$warehouseCounts["MS"]
    }
    target_sheets = $targetSheetNames
    per_sheet = $perSheetSummary
    skip_reasons = [pscustomobject]$globalReasonCounts
    baseline_reference = [pscustomobject][ordered]@{
      expected_accepted_approx = 644
      expected_skipped_approx = 36
    }
    critical_success_gates = [pscustomobject][ordered]@{
      use_test_or_new_org = $true
      run_import_clear_staging_before_each_attempt = $true
      review_collision_and_exception_files_before_live_load = $true
      ensure_boxes_raw_header_matches_import_table = $true
      post_load_verify_counts_duplicates_required_fields_and_warehouse_split = $true
    }
  }

  $summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $summaryJsonPath -Encoding UTF8

  Write-Host "Dry-run transform complete."
  Write-Host "Accepted rows: $acceptedCount"
  Write-Host "Skipped rows:  $skippedCount"
  Write-Host "Collisions:    $collisionCount"
  Write-Host "Artifacts:"
  Write-Host "  $boxesCsvPath"
  Write-Host "  $exceptionsCsvPath"
  Write-Host "  $collisionsCsvPath"
  Write-Host "  $summaryJsonPath"
} finally {
  $archive.Dispose()
}
