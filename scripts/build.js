const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const files = ['manifest.json', 'background.js', 'content.js', 'secure-store.js'];
const dirs = ['popup', 'icons'];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const f of files) {
  fs.copyFileSync(path.join(root, f), path.join(dist, f));
}
for (const d of dirs) {
  fs.cpSync(path.join(root, d), path.join(dist, d), { recursive: true });
}

console.log('빌드 완료 → ' + dist);
console.log('이 경로를 chrome://extensions 에서 로드하세요.');