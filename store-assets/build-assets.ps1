# build-assets.ps1
# Regenerates icon PNGs (16/32/48/128) from the TS logo,
# builds the 440x280 promo tile, and renders each captured
# screenshot onto a 1280x800 canvas for CWS submission.

Add-Type -AssemblyName System.Drawing

$logo     = "C:\Users\bmaher_tactacam\Downloads\Gemini_Generated_Image_vgqrjpvgqrjpvgqr.png"
$projRoot = "C:\Users\bmaher_tactacam\Documents\NetSuite Projects\ChromeExtension\TactaSuiteNSToolkit"
$iconDir  = Join-Path $projRoot "icons"
$promoDir = Join-Path $projRoot "store-assets\promo"
$shotsDir = Join-Path $projRoot "store-assets\screenshots"

foreach ($d in @($iconDir, $promoDir, $shotsDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ── Load the logo and define a center-square crop around the TS mark ──
$logoImg  = [System.Drawing.Image]::FromFile($logo)
$cropSize = $logoImg.Height
$cropX    = [int](($logoImg.Width - $cropSize) / 2)
$srcRect  = New-Object System.Drawing.Rectangle $cropX, 0, $cropSize, $cropSize

function New-Graphics($bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode        = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode    = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode      = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint    = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    return $g
}

# ── Generate icons ──
foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g   = New-Graphics $bmp
    $destRect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $g.DrawImage($logoImg, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $path = Join-Path $iconDir ("icon" + $size + ".png")
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("icon{0}.png  ({1}x{1})" -f $size, $size)
}

# ── Promo tile 440x280 ──
$promo = New-Object System.Drawing.Bitmap 440, 280
$g     = New-Graphics $promo

$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($bg, 0, 0, 440, 280)
$bg.Dispose()

$logoTile = 220
$logoX    = 18
$logoY    = ([int](280 - $logoTile) / 2)
$dst      = New-Object System.Drawing.Rectangle $logoX, $logoY, $logoTile, $logoTile
$g.DrawImage($logoImg, $dst, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

$titleFont  = New-Object System.Drawing.Font "Georgia", 24, ([System.Drawing.FontStyle]::Regular)
$titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 20, 20))
$g.DrawString("TactaSuite", $titleFont, $titleBrush, 252, 86)
$g.DrawString("NS Toolkit", $titleFont, $titleBrush, 252, 118)

$subFont  = New-Object System.Drawing.Font "Segoe UI", 9
$subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(105, 105, 105))
$g.DrawString("Chrome extension for NetSuite", $subFont, $subBrush, 254, 168)
$g.DrawString("developer productivity.", $subFont, $subBrush, 254, 184)

$titleFont.Dispose(); $subFont.Dispose(); $titleBrush.Dispose(); $subBrush.Dispose()
$g.Dispose()
$promoPath = Join-Path $promoDir "promo-small-440x280.png"
$promo.Save($promoPath, [System.Drawing.Imaging.ImageFormat]::Png)
$promo.Dispose()
Write-Output ("promo-small-440x280.png written: " + $promoPath)

# ── Screenshots 1280x800 ──
$shots = @(
    @{ src = "C:\Users\bmaher_tactacam\Pictures\Screenshots\Screenshot 2026-05-22 152853.png"; out = "screenshot-1-popup-user.png" },
    @{ src = "C:\Users\bmaher_tactacam\Pictures\Screenshots\Screenshot 2026-05-22 152929.png"; out = "screenshot-2-popup-developer.png" },
    @{ src = "C:\Users\bmaher_tactacam\Pictures\Screenshots\Screenshot 2026-05-22 152905.png"; out = "screenshot-3-options-top.png" },
    @{ src = "C:\Users\bmaher_tactacam\Pictures\Screenshots\Screenshot 2026-05-22 152913.png"; out = "screenshot-4-options-quicksearch.png" }
)

foreach ($s in $shots) {
    if (-not (Test-Path $s.src)) { Write-Output ("MISSING: " + $s.src); continue }
    $src    = [System.Drawing.Image]::FromFile($s.src)
    $canvas = New-Object System.Drawing.Bitmap 1280, 800
    $g      = New-Graphics $canvas

    $darkBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 26, 26))
    $g.FillRectangle($darkBg, 0, 0, 1280, 800)
    $darkBg.Dispose()

    $padding = 40
    $maxW    = 1280 - 2 * $padding
    $maxH    = 800  - 2 * $padding
    $ratio   = [Math]::Min($maxW / $src.Width, $maxH / $src.Height)
    $newW    = [int]($src.Width  * $ratio)
    $newH    = [int]($src.Height * $ratio)
    $x       = [int]((1280 - $newW) / 2)
    $y       = [int](( 800 - $newH) / 2)
    $g.DrawImage($src, $x, $y, $newW, $newH)

    $g.Dispose()
    $outPath = Join-Path $shotsDir $s.out
    $canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose()
    $src.Dispose()
    Write-Output ("{0,-40} ({1}x{2} -> 1280x800)" -f $s.out, $src.Width, $src.Height)
}

$logoImg.Dispose()
Write-Output "DONE"
