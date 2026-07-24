# acro before/after photo sync v1_2 (ASCII-safe) - DESK3
# Copies two Google Drive folders (acrohani75) into E:\acro every 30 min (one-way, no delete).
# Folder names are built from char codes so the file works regardless of its text encoding.

$rclone = "C:\rclone\rclone.exe"
$conf   = "C:\rclone\rclone.conf"
$log    = "C:\rclone\sync.log"
$dst    = "E:\acro"

# Folder names (star + Korean) built from code points to stay encoding-safe
$consent   = -join ([int[]](0x2605,0xC2DC,0xC220,0xC2E4,0x5F,0xC804,0xD6C4,0xC0AC,0xC9C4) | ForEach-Object { [char]$_ })
$noconsent = -join ([int[]](0x2605,0xC2DC,0xC220,0xC2E4,0x5F,0xC804,0xD6C4,0xC0AC,0xC9C4,0x28,0xD65C,0xC6A9,0xB3D9,0xC758,0xC548,0xD568,0x29) | ForEach-Object { [char]$_ })

$mutex = New-Object System.Threading.Mutex($false, "Global\AcroPhotoSync")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Sync-One($srcName) {
    & $rclone copy ("gdrive:" + $srcName) (Join-Path $dst $srcName) `
        --config $conf --create-empty-src-dirs --log-file $log --log-level INFO 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Add-Content $log ("[" + (Get-Date).ToString("s") + "] exit " + $LASTEXITCODE + " on " + $srcName + " (source folder may not exist yet = OK)")
    }
}

try {
    Sync-One $consent
    Sync-One $noconsent
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 10MB)) {
        Get-Content $log -Tail 500 | Set-Content ($log + ".prev")
        Clear-Content $log
    }
}
finally {
    $mutex.ReleaseMutex()
}
