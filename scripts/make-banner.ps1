# renders docs/banner.png (1920x1080) with gdi+. rerun after icon changes.
#   powershell -File scripts/make-banner.ps1
Add-Type -AssemblyName System.Drawing

$W = 1920; $H = 1080
$ink = [System.Drawing.Color]::FromArgb(255, 11, 12, 8)        # #0B0C08
$ink2 = [System.Drawing.Color]::FromArgb(255, 22, 26, 13)      # #161A0D
$line2 = [System.Drawing.Color]::FromArgb(255, 50, 56, 35)     # #323823
$acid = [System.Drawing.Color]::FromArgb(255, 216, 255, 61)    # #D8FF3D
$acidDeep = [System.Drawing.Color]::FromArgb(255, 157, 187, 38)
$text = [System.Drawing.Color]::FromArgb(255, 233, 237, 218)   # #E9EDDA
$mute = [System.Drawing.Color]::FromArgb(255, 131, 138, 110)   # #838A6E

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear($ink)

# dotted engineering grid
$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(14, 216, 255, 61))
for ($x = 13; $x -lt $W; $x += 26) {
    for ($y = 13; $y -lt $H; $y += 26) {
        $g.FillEllipse($dot, $x, $y, 2.4, 2.4)
    }
}

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# ── the icon, large: same colors as icon.ico (ink fill, no tint) ────────────
$size = 400
$ix = ($W - $size) / 2
$iy = 170
$sq = New-RoundedRect $ix $iy $size $size ($size * 0.22)
$g.FillPath((New-Object System.Drawing.SolidBrush($ink)), $sq)
$g.DrawPath((New-Object System.Drawing.Pen($line2, 2)), $sq)

# bolt polygon from the 20x20 design grid, mapped exactly like the .ico
$boltDesign = @(
    @(11.5, 1), @(3, 11.5), @(8, 11.5), @(8.5, 19), @(17, 8.5), @(12, 8.5)
)
$boltPts = New-Object 'System.Drawing.PointF[]' 6
for ($i = 0; $i -lt 6; $i++) {
    $bx = ($boltDesign[$i][0] / 20) * $size
    $by = ($boltDesign[$i][1] / 20) * $size
    $boltPts[$i] = New-Object System.Drawing.PointF(($ix + $bx), ($iy + $by))
}
$g.FillPolygon((New-Object System.Drawing.SolidBrush($acid)), $boltPts)

# ── title: QUEST (text) / RIG (acid) ────────────────────────────────────────
$fTitle = New-Object System.Drawing.Font('Segoe UI Black', 120)
$fSub = New-Object System.Drawing.Font('Consolas', 34)
$fFoot = New-Object System.Drawing.Font('Consolas', 22)

$wt = 'QUEST'; $rt = '/RIG'
$fmt = New-Object System.Drawing.StringFormat
$wtW = $g.MeasureString($wt, $fTitle).Width
$rtW = $g.MeasureString($rt, $fTitle).Width
$startX = ($W - ($wtW + $rtW)) / 2
$ty = 640
$g.DrawString($wt, $fTitle, (New-Object System.Drawing.SolidBrush($text)), $startX, $ty, $fmt)
$g.DrawString($rt, $fTitle, (New-Object System.Drawing.SolidBrush($acid)), ($startX + $wtW), $ty, $fmt)

# ── subtitle with manual letter-spacing ─────────────────────────────────────
$sub = 'D I S C O R D   Q U E S T   F A R M E R'
$subW = $g.MeasureString($sub, $fSub).Width
$br = New-Object System.Drawing.SolidBrush($mute)
$g.DrawString($sub, $fSub, $br, (($W - $subW) / 2), 880, $fmt)

# accent rules flanking the subtitle
$pen = New-Object System.Drawing.Pen($acidDeep, 3)
$pad = 60
$g.DrawLine($pen, ($W - $subW) / 2 - $pad - 180, 904, ($W - $subW) / 2 - $pad, 904)
$g.DrawLine($pen, ($W + $subW) / 2 + $pad, 904, ($W + $subW) / 2 + $pad + 180, 904)

# footer tags (middle dot built via char code to stay ASCII-safe in PS 5.1)
$mid = [string][char]183
$foot = 'PLAY-A-GAME QUESTS  ' + $mid + '  15:00 TIMERS  ' + $mid + '  MULTI-SESSION  ' + $mid + '  WINDOWS'
$fW = $g.MeasureString($foot, $fFoot).Width
$g.DrawString($foot, $fFoot, $br, (($W - $fW) / 2), 960, $fmt)

$out = Join-Path (Split-Path $PSScriptRoot) 'docs\banner.png'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "wrote $out"
