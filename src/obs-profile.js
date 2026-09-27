'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function obsRoot() {
  return process.env.OBS_CONFIG_DIR || path.join(process.env.APPDATA || os.homedir(), 'obs-studio');
}

function profileDir(profileName) {
  return path.join(obsRoot(), 'basic', 'profiles', profileName);
}

function profileFile(profileName) {
  return path.join(profileDir(profileName), 'basic.ini');
}

function listProfiles() {
  const dir = path.join(obsRoot(), 'basic', 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function ensureProfile(profileName) {
  if (listProfiles().includes(profileName)) return profileName;
  fs.mkdirSync(profileDir(profileName), { recursive: true });
  return profileName;
}

function readIni(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const sections = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections[current]) sections[current] = {};
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    sections[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

function upsertIni(text, section, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const target = section.toLowerCase();
  let inSection = false;
  let sectionFound = false;
  let replaced = false;
  let lastIndexOfSection = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header) {
      inSection = header[1].toLowerCase() === target;
      if (inSection) {
        sectionFound = true;
        lastIndexOfSection = i;
      }
      continue;
    }
    if (!inSection || !trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      lines[i] = `${key}=${value}`;
      replaced = true;
    }
  }

  if (replaced) return lines.join(eol);

  if (!sectionFound) {
    const block = [];
    if (lines.length && lines[lines.length - 1].trim()) block.push('');
    block.push(`[${section}]`, `${key}=${value}`, '');
    return lines.concat(block).join(eol);
  }

  let insertAt = lastIndexOfSection + 1;
  for (let i = lastIndexOfSection + 1; i < lines.length; i += 1) {
    if (/^\[.+\]$/.test(lines[i].trim())) break;
    if (lines[i].trim() === '') continue;
    insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `${key}=${value}`);
  return lines.join(eol);
}

function applyPatch(file, patch) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let text = original;
  const changes = [];

  for (const [section, entries] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(entries)) {
      const before = readIni(text)[section]?.[key];
      text = upsertIni(text, section, key, value);
      changes.push({ section, key, value, before: before ?? null });
    }
  }

  return { text, changes, original, changed: text !== original };
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.${stamp}.bak`;
  fs.copyFileSync(file, backup);
  return backup;
}

function writeProfile({ profileName, patch, apply }) {
  ensureProfile(profileName);
  const file = profileFile(profileName);
  const result = applyPatch(file, patch);

  if (!apply) {
    return { file, written: false, ...result };
  }

  let backup = null;
  if (result.original) backup = backupFile(file);
  fs.writeFileSync(file, result.text, 'utf8');
  return { file, written: true, backup, ...result };
}

function isObsRunning() {
  return /obs64\.exe/i.test(processOutput('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH'])) ||
    /obs32\.exe/i.test(processOutput('tasklist', ['/FI', 'IMAGENAME eq obs32.exe', '/NH']));
}

function processOutput(command, args) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  } catch {
    return '';
  }
}

function currentSettings(profileName) {
  return readIni(profileFile(profileName));
}

module.exports = {
  obsRoot,
  profileDir,
  profileFile,
  listProfiles,
  ensureProfile,
  readIni,
  upsertIni,
  applyPatch,
  writeProfile,
  currentSettings,
  isObsRunning,
};
