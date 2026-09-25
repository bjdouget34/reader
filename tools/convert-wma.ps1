<#
.SYNOPSIS
  Converts WMA audiobook files to MP3 so the reader can play them.

.DESCRIPTION
  Browsers cannot play Windows Media (WMA), so an audiobook in WMA has to be
  converted before the reader will take it. This does it with VLC, which is
  already installed here, one file at a time:

    - The originals are never touched. The MP3s go into a new folder beside
      the source folder, named "<source folder> (MP3)", with the same file
      names, so they sort and play in the same order.
    - Copy-protected (DRM) WMA files are skipped with a note. Nothing can
      convert those; they only play in the software they were sold for.
    - Each file is written under a temporary name and only renamed once it has
      been checked, so a run that is interrupted cannot leave a half-converted
      file looking finished. Files already converted are skipped, so running
      it again just picks up where it stopped.
    - Each result is checked: it must be a real MP3, and its size must match
      the source's length at the chosen bitrate. A conversion that stopped
      early is reported, not passed off as finished.

  Tags (title, author) are not carried over. The reader names tracks by their
  file names and sorts them naturally, so "part 2" comes before "part 10".

.PARAMETER Path
  One or more folders holding .wma files, or individual .wma files.

.PARAMETER Bitrate
  MP3 bitrate in kbps. 96 is plenty for narration and keeps a ten-hour book
  near 400 MB; 128 if you want music-grade quality.

.PARAMETER OutDir
  Where to put the MP3s instead of "<source folder> (MP3)".

.PARAMETER Force
  Convert again even where an MP3 already exists.

.PARAMETER Vlc
  Path to vlc.exe, if it is not in the usual place.

.EXAMPLE
  pwsh -File tools\convert-wma.ps1 "Sample_Audiobooks\Napoleon Hill - Think and Grow Rich [Audio Book]"

.EXAMPLE
  pwsh -File tools\convert-wma.ps1 "D:\Audiobooks\Some Book" -Bitrate 64
#>
#Requires -Version 7
param(
  [Parameter(Mandatory, Position = 0)] [string[]] $Path,
  [ValidateRange(32, 320)] [int] $Bitrate = 96,
  [string] $OutDir,
  [switch] $Force,
  [string] $Vlc
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------- VLC

function Find-Vlc {
  if ($Vlc) {
    if (Test-Path -LiteralPath $Vlc -PathType Leaf) { return (Resolve-Path -LiteralPath $Vlc).Path }
    throw "No vlc.exe at $Vlc"
  }
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'VideoLAN\VLC\vlc.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'VideoLAN\VLC\vlc.exe'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  $onPath = Get-Command vlc.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw "VLC was not found. Install it from https://www.videolan.org (or: winget install VideoLAN.VLC), or pass -Vlc with the path to vlc.exe."
}

# --------------------------------------------------------- the WMA header
#
# A WMA file is an ASF container, which opens with a header object holding
# further objects, each a 16-byte GUID and an 8-byte size. Two of them matter:
# File Properties, which states the length, and Content Encryption, whose
# presence means the file is copy-protected.

$GUID_HEADER    = [Guid]'75B22630-668E-11CF-A6D9-00AA0062CE6C'
$GUID_FILEPROPS = [Guid]'8CABDCA1-A947-11CF-8EE4-00C00C205365'
$GUID_DRM       = @([Guid]'2211B3FB-BD23-11D2-B4B7-00A0C955FC6E', [Guid]'298AE614-2622-4C17-B935-DAE07EE9289C')

function Read-WmaHeader([string] $file) {
  $stream = [IO.File]::OpenRead($file)
  try {
    $buf = New-Object byte[] ([Math]::Min(262144, $stream.Length))
    [void] $stream.Read($buf, 0, $buf.Length)
  } finally { $stream.Dispose() }
  if ($buf.Length -lt 30 -or [Guid]::new([byte[]] $buf[0..15]) -ne $GUID_HEADER) {
    return @{ asf = $false; drm = $false; seconds = $null }
  }
  $count = [BitConverter]::ToUInt32($buf, 24)
  $p = 30
  $seconds = $null
  $drm = $false
  for ($i = 0; $i -lt $count -and $p + 24 -le $buf.Length; $i++) {
    $id = [Guid]::new([byte[]] $buf[$p..($p + 15)])
    $size = [BitConverter]::ToUInt64($buf, $p + 16)
    if ($size -lt 24) { break }
    if ($GUID_DRM -contains $id) { $drm = $true }
    if ($id -eq $GUID_FILEPROPS -and $p + 88 -le $buf.Length) {
      $play = [BitConverter]::ToUInt64($buf, $p + 64)      # 100-nanosecond units
      $preroll = [BitConverter]::ToUInt64($buf, $p + 80)   # milliseconds
      $seconds = $play / 1e7 - $preroll / 1000
    }
    $p += [int] $size
  }
  return @{ asf = $true; drm = $drm; seconds = $seconds }
}

# ----------------------------------------------------------------- inputs

$vlcExe = Find-Vlc

# -LiteralPath throughout: audiobook folders are often named like
# "Some Book [Audio Book]", and to PowerShell's ordinary -Path those square
# brackets are a wildcard pattern -- which matches nothing, silently.
$jobs = @()
foreach ($item in $Path) {
  if (-not (Test-Path -LiteralPath $item)) { throw "Not found: $item" }
  $resolved = (Resolve-Path -LiteralPath $item).Path
  if (Test-Path -LiteralPath $resolved -PathType Container) {
    $sourceDir = Get-Item -LiteralPath $resolved
    $files = Get-ChildItem -LiteralPath $resolved -File | Where-Object { $_.Extension -ieq '.wma' }
  } else {
    $file = Get-Item -LiteralPath $resolved
    if ($file.Extension -ine '.wma') { throw "Not a .wma file: $item" }
    $sourceDir = $file.Directory
    $files = @($file)
  }
  $target = if ($OutDir) { $OutDir } else { Join-Path $sourceDir.Parent.FullName "$($sourceDir.Name) (MP3)" }
  foreach ($f in $files) { $jobs += [pscustomobject]@{ Source = $f; OutDir = $target } }
}
if (-not $jobs.Count) { Write-Host 'No .wma files found.'; exit 0 }

# Natural order, so the report reads part 1, part 2 ... part 10.
$natural = { [regex]::Replace($_.Source.Name, '\d+', { $args[0].Value.PadLeft(10, '0') }) }
$jobs = $jobs | Sort-Object $natural

# VLC's output option is one string with the destination embedded in it, where
# a quote or a brace in the path would end it early. So each file is written to
# a plain name in the temp folder and moved into place once checked.
$workDir = Join-Path ([IO.Path]::GetTempPath()) 'wma-to-mp3'
if ($workDir -match "['{}]") { throw "The temp folder path contains a quote or a brace, which VLC cannot take: $workDir" }
[void] (New-Item -ItemType Directory -Force -Path $workDir)

# ------------------------------------------------------------- converting

$converted = 0; $skipped = 0; $failed = 0; $bytesOut = 0
$n = 0
foreach ($job in $jobs) {
  $n++
  $src = $job.Source.FullName
  $dest = Join-Path $job.OutDir ([IO.Path]::ChangeExtension($job.Source.Name, '.mp3'))
  $label = "[$n/$($jobs.Count)] $($job.Source.Name)"

  if ((Test-Path -LiteralPath $dest) -and -not $Force) {
    Write-Host "$label -- already converted, skipped"
    $skipped++
    continue
  }

  $header = Read-WmaHeader $src
  if (-not $header.asf) { Write-Host "$label -- not a Windows Media file, skipped" -ForegroundColor Yellow; $failed++; continue }
  if ($header.drm) {
    Write-Host "$label -- copy-protected (DRM). It only plays in the software it was sold for, and no converter can open it." -ForegroundColor Yellow
    $failed++
    continue
  }

  [void] (New-Item -ItemType Directory -Force -Path $job.OutDir)
  $work = Join-Path $workDir "converting-$n.mp3"
  if ([IO.File]::Exists($work)) { [IO.File]::Delete($work) }

  # Each argument handed over separately, so nothing in a file name can be
  # misread as the end of one argument and the start of another.
  $psi = [Diagnostics.ProcessStartInfo]::new($vlcExe)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  foreach ($a in @('-I', 'dummy', '--no-repeat', '--no-loop', $src,
                   "--sout=#transcode{vcodec=none,acodec=mp3,ab=$Bitrate,channels=2,samplerate=44100}:std{access=file,mux=raw,dst='$work'}",
                   'vlc://quit')) { $psi.ArgumentList.Add($a) }

  $minutes = if ($header.seconds) { '{0:N1} min' -f ($header.seconds / 60) } else { 'length unknown' }
  Write-Host "$label ($minutes) ..." -NoNewline
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $proc = [Diagnostics.Process]::Start($psi)
  # VLC runs far faster than real time; an hour to convert anything means it
  # has hung, not that it is still working.
  $limitMs = if ($header.seconds) { [int] [Math]::Max(120000, $header.seconds * 1000) } else { 3600000 }
  if (-not $proc.WaitForExit($limitMs)) {
    $proc.Kill()
    Write-Host " VLC stopped responding and was closed." -ForegroundColor Red
    $failed++
    continue
  }

  # The check. A real MP3 opens with a frame sync (FF Ex/Fx) or an ID3 tag,
  # and at a constant bitrate its size is the length times the bitrate.
  $ok = $false; $why = 'VLC produced no file'
  if ([IO.File]::Exists($work)) {
    $size = (Get-Item -LiteralPath $work).Length
    $head = [byte[]] (Get-Content -LiteralPath $work -AsByteStream -TotalCount 3)
    $looksMp3 = $head.Count -ge 3 -and (($head[0] -eq 0xFF -and ($head[1] -band 0xE0) -eq 0xE0) -or ($head[0] -eq 0x49 -and $head[1] -eq 0x44 -and $head[2] -eq 0x33))
    if (-not $looksMp3) {
      $why = 'the output is not an MP3'
    } elseif ($header.seconds) {
      $expected = $header.seconds * $Bitrate * 1000 / 8
      $ratio = $size / $expected
      if ($ratio -lt 0.9 -or $ratio -gt 1.1) { $why = ('the output is {0:P0} of the expected size -- the conversion likely stopped early' -f $ratio) }
      else { $ok = $true }
    } else {
      $ok = $size -gt 0
    }
  }

  if ($ok) {
    Move-Item -LiteralPath $work -Destination $dest -Force
    $bytesOut += $size
    $converted++
    Write-Host (" done in {0:N0} s, {1:N1} MB" -f $clock.Elapsed.TotalSeconds, ($size / 1MB)) -ForegroundColor Green
  } else {
    if ([IO.File]::Exists($work)) { [IO.File]::Delete($work) }
    Write-Host " FAILED: $why." -ForegroundColor Red
    $failed++
  }
}

# ---------------------------------------------------------------- summary

Write-Host ''
Write-Host ("Converted {0}, skipped {1} already done, failed {2}. {3:N1} MB written." -f $converted, $skipped, $failed, ($bytesOut / 1MB))
$folders = $jobs.OutDir | Sort-Object -Unique | Where-Object { Test-Path -LiteralPath $_ }
foreach ($f in $folders) { Write-Host "MP3s are in: $f" }
if ($converted -or $skipped) {
  Write-Host 'In the reader: open the book, tap the Audio button, and select all the MP3s in that folder.'
}
if ($failed) { exit 1 }
