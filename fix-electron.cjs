const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const electronDir = path.join(__dirname, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const pathFile = path.join(electronDir, 'path.txt');

console.log('==================================================');
console.log('   Bamboo Launcher - Electron Pfad-Korrektur (CJS) ');
console.log('==================================================\n');

try {
    // 1. Ordnerstruktur neu aufbauen, falls npm sie gelöscht hat
    if (!fs.existsSync(electronDir)) {
        fs.mkdirSync(electronDir, { recursive: true });
    }
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // 2. Automatisch Electron v31.7.7 herunterladen und entpacken via PowerShell (Bypass npm)
    console.log('-> Lade Electron v31.7.7 herunter (Dauert kurz, ca. 100MB)...');
    const url = 'https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-win32-x64.zip';
    const zipPath = path.join(__dirname, 'electron_temp.zip');
    
    // Nutze PowerShell im Hintergrund, um den fehlerhaften npm-Downloader komplett zu umgehen
    execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}'"`, { stdio: 'inherit' });
    
    console.log('-> Entpacke Binärdateien direkt nach node_modules/electron/dist...');
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${distDir}' -Force"`, { stdio: 'inherit' });
    
    // Temporäre Zip-Datei aufräumen
    if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
    }

    // 3. Pfad-Bug korrigieren
    console.log('-> Korrigiere path.txt auf "electron.exe"...');
    fs.writeFileSync(pathFile, 'electron.exe', 'utf8');

    console.log('\n✅ Electron erfolgreich komplett manuell installiert und repariert!');
    console.log('--------------------------------------------------');
    console.log('Du kannst deinen Launcher jetzt wieder starten mit:');
    console.log('   npx electron .');
    console.log('--------------------------------------------------\n');

} catch (error) {
    console.error('❌ Ein Fehler ist aufgetreten:', error);
}