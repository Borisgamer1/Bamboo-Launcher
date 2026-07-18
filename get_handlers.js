const fs = require('fs');
const content = fs.readFileSync('main.js', 'utf8');
const lines = content.split('\n');

for(let i = 0; i < lines.length; i++) {
  if(lines[i].includes("ipcMain.handle('export-profile'")) {
    console.log('=== export-profile handler at line', i+1, '===');
    for(let j = i; j < Math.min(i+120, lines.length); j++) {
      console.log((j+1) + ': ' + lines[j]);
      if (lines[j].trim() === '});') break;
    }
    console.log('\n');
  }
  if(lines[i].includes("ipcMain.handle('import-preview'")) {
    console.log('=== import-preview handler at line', i+1, '===');
    for(let j = i; j < Math.min(i+100, lines.length); j++) {
      console.log((j+1) + ': ' + lines[j]);
      if (lines[j].trim() === '});') break;
    }
    console.log('\n');
  }
  if(lines[i].includes("ipcMain.handle('import-profile'")) {
    console.log('=== import-profile handler at line', i+1, '===');
    for(let j = i; j < Math.min(i+100, lines.length); j++) {
      console.log((j+1) + ': ' + lines[j]);
      if (lines[j].trim() === '});') break;
    }
    console.log('\n');
  }
}
