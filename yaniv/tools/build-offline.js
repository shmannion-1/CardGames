// Builds dist/yaniv-offline.html: one self-contained file (vs computer + pass-and-play).
// Handy to AirDrop or open straight from Files; online play needs the server version.
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(pub, 'icons', 'icon-180.png')).toString('base64');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + css + '\n</style>');
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
html = html.replace(/href="icons\/icon-1[89][02]\.png"/g, () => 'href="' + icon + '"');
html = html.replace(/<script src="js\/([a-z]+\.js)"><\/script>/g, (_, f) =>
  '<script>\n' + fs.readFileSync(path.join(pub, 'js', f), 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>');
html = html.replace(/<script>\s*if \('serviceWorker'[\s\S]*?<\/script>\n?/, '');
fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
const out = path.join(__dirname, '..', 'dist', 'yaniv-offline.html');
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
