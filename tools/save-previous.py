# Before each release: keep the version that is live right now at app/previous/ on the web,
# so the iPad can open it if a new update has a problem. Run from the repo root before committing.
import json, re, subprocess
subprocess.run(['git', 'fetch', '-q', 'origin', 'main'], check=True)
html = subprocess.run(['git', 'show', 'FETCH_HEAD:app/index.html'], capture_output=True, text=True, check=True).stdout
ver = json.loads(subprocess.run(['git', 'show', 'FETCH_HEAD:app/version.json'], capture_output=True, text=True, check=True).stdout)['version']
html = html.replace('"vendor/', '"../vendor/').replace("'vendor/", "'../vendor/")
html = html.replace('href="icon.png"', 'href="../icon.png"')
html = re.sub(r'<link rel="manifest"[^>]*>', '', html)           # not installable as a separate app
html = html.replace('<title>', '<meta name="robots" content="noindex"><title>', 1)
open('app/previous/index.html', 'w').write(html)
open('app/previous/version.json', 'w').write(json.dumps({'version': ver}) + '\n')
print('app/previous/ is now version', ver)
