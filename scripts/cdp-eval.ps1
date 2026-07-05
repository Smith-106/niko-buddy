param(
  [Parameter(Mandatory=$true)][string]$Expr,
  [int]$TimeoutMs = 15000
)
Add-Type -AssemblyName System.Net.WebSockets -ErrorAction SilentlyContinue

$disc = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json" -UseBasicParsing -TimeoutSec 5 | ConvertFrom-Json
$page = $disc | Where-Object { $_.type -eq "page" } | Select-Object -First 1
if (-not $page) { throw "No CDP page target found on port 9222" }
$wsUrl = $page.webSocketDebuggerUrl

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = New-Object System.Threading.CancellationTokenSource($TimeoutMs)
$ws.ConnectAsync([Uri]$wsUrl, $ct.Token).Wait(8000) | Out-Null
if ($ws.State -ne 'Open') { throw "WS not open: $($ws.State)" }

$id = 1
$msg = @{ id=$id; method="Runtime.evaluate"; params=@{ expression=$Expr; returnByValue=$true; awaitPromise=$true } } | ConvertTo-Json -Compress -Depth 20
$msgBytes = [Text.Encoding]::UTF8.GetBytes($msg)
$ws.SendAsync([ArraySegment[byte]]::new($msgBytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct.Token).Wait(5000) | Out-Null

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$respJson = $null
while ((Get-Date) -lt $deadline) {
  $buf = New-Object byte[] 131072
  $recv = $ws.ReceiveAsync((New-Object ArraySegment[byte]($buf, 0, $buf.Length)), $ct.Token)
  $waitMs = [int](([timespan]($deadline - (Get-Date))).TotalMilliseconds)
  if ($waitMs -lt 0) { $waitMs = 0 }
  if ($waitMs -gt 8000) { $waitMs = 8000 }
  if (-not $recv.Wait($waitMs)) { break }
  $chunk = [Text.Encoding]::UTF8.GetString($buf, 0, $recv.Result.Count)
  try {
    $parsed = $chunk | ConvertFrom-Json
    if ($parsed.id -eq $id) { $respJson = $parsed; break }
  } catch { }
}
$ws.Dispose()
if (-not $respJson) { throw "No response with matching id within timeout" }
if ($respJson.result.result.value) {
  $respJson.result.result.value
} elseif ($respJson.result.result.description) {
  "EVAL_DESC: $($respJson.result.result.description)"
} elseif ($respJson.result.exceptionDetails) {
  "EVAL_EXC: $($respJson.result.exceptionDetails | ConvertTo-Json -Compress -Depth 10)"
} else {
  $respJson | ConvertTo-Json -Compress -Depth 10
}
