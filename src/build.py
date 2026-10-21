# Rebuilds ../index.html from src.html: inlines the municipality map (japan-munis.json, from jpn-atlas BSD-3 / jp-local-gov MIT)
# and sb-db.js, and wraps everything in a full HTML document. Run: python3 src/build.py
import pathlib
d = pathlib.Path(__file__).parent
s = (d / "src.html").read_text()
m = '/*__MAP__*/{munis:[],prefB:""}'
assert m in s
s = s.replace(m, (d / "japan-munis.json").read_text())
head, body = s.split("</style>", 1)
head += "</style>"
main = "<script>\nconst MAP="
assert body.count(main) == 1
body = body.replace(main, "<script>\n" + (d / "sb-db.js").read_text() + "\n</script>\n" + main)
doc = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' data: blob: https://*.supabase.co wss://*.supabase.co https://nominatim.openstreetmap.org; object-src 'none'; base-uri 'self'; form-action 'self'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="theme-color" content="#fcf6ea">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="腹ぱんぐらむ">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-180.png">
<script src="config.js"></script>
<script src="supabase.js"></script>
{head}
</head>
<body>
{body}
</body>
</html>
"""
(d.parent / "index.html").write_text(doc)
print("built index.html")
