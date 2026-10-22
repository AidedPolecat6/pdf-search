Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
$sectionSign = [char]0x00A7

foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $radius = [Math]::Max(2, [int]($size * 0.21))
  $diameter = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
  $path.AddArc($size - $diameter - 1, 0, $diameter, $diameter, 270, 90)
  $path.AddArc($size - $diameter - 1, $size - $diameter - 1, $diameter, $diameter, 0, 90)
  $path.AddArc(0, $size - $diameter - 1, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  $graphics.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(16, 24, 33))), $path)

  $font = New-Object System.Drawing.Font('Segoe UI Symbol', ($size * 0.67), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rectangle = New-Object System.Drawing.RectangleF(0, ($size * -0.035), $size, $size)
  $graphics.DrawString($sectionSign, $font, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240, 184, 75))), $rectangle, $format)

  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($size -eq 256) {
    $bitmap.Save((Join-Path $PSScriptRoot '..\build\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $images += ,$stream.ToArray()
  $stream.Dispose()
  $format.Dispose()
  $font.Dispose()
  $path.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

$output = Join-Path $PSScriptRoot '..\build\icon.ico'
$file = [System.IO.File]::Create($output)
$writer = New-Object System.IO.BinaryWriter($file)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count

for ($index = 0; $index -lt $images.Count; $index++) {
  $size = $sizes[$index]
  $data = $images[$index]
  $writer.Write([Byte]$(if ($size -eq 256) { 0 } else { $size }))
  $writer.Write([Byte]$(if ($size -eq 256) { 0 } else { $size }))
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$data.Length)
  $writer.Write([UInt32]$offset)
  $offset += $data.Length
}

foreach ($data in $images) { $writer.Write($data) }
$writer.Dispose()
$file.Dispose()
