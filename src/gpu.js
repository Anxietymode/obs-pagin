'use strict';

const { execFileSync } = require('node:child_process');

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    }).trim();
  } catch {
    return '';
  }
}

function listAdapters() {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8;",
    "$rows = Get-CimInstance Win32_VideoController | ForEach-Object {",
    "  $vram = 0;",
    "  if ($_.AdapterRAM) { $vram = [math]::Round($_.AdapterRAM / 1MB) }",
    "  'GPU' + [char]31 + $_.Name + [char]31 + $_.DriverVersion + [char]31 + $vram",
    "};",
    "$rows -join [char]30",
  ].join(' ');

  const raw = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);

  const adapters = [];
  for (const line of raw.split(/[\u001e\r\n]/)) {
    const parts = line.split('\u001f');
    if (parts.length >= 2 && parts[0] === 'GPU' && parts[1]) {
      adapters.push({
        name: parts[1].trim(),
        driver: (parts[2] || '').trim(),
        vramMB: Number(parts[3]) || 0,
      });
    }
  }

  if (adapters.length) return adapters;

  const smi = run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  for (const line of smi.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((part) => part.trim());
    adapters.push({ name: parts[0], driver: parts[1] || '', vramMB: 0 });
  }
  return adapters;
}

function vendorOf(name) {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (/amd|radeon|firepro|arc/i.test(name)) return 'amd';
  if (/intel|arc a|iris|uhd graphics|hd graphics/i.test(name)) return 'intel';
  return null;
}

function encoderFor(vendor) {
  if (vendor === 'nvidia') return 'nvenc';
  if (vendor === 'amd') return 'amd';
  if (vendor === 'intel') return 'qsv';
  return 'x264';
}

function describeGpu(gpu) {
  const labels = {
    nvenc: 'NVIDIA NVENC (аппаратный, лучший выбор)',
    amd: 'AMD AMF / VCE (аппаратный)',
    qsv: 'Intel Quick Sync (аппаратный)',
    x264: 'x264 (программный, CPU)',
  };
  return labels[gpu.encoder] || labels.x264;
}

function detectGpu() {
  const adapters = listAdapters();
  if (!adapters.length) {
    return {
      adapters: [],
      primary: null,
      vendor: null,
      encoder: 'x264',
      hardware: false,
      description: describeGpu({ encoder: 'x264' }),
    };
  }

  const ranked = [...adapters].sort((a, b) => {
    const order = { nvidia: 0, amd: 1, intel: 2 };
    const av = order[vendorOf(a.name)] ?? 3;
    const bv = order[vendorOf(b.name)] ?? 3;
    if (av !== bv) return av - bv;
    return b.vramMB - a.vramMB;
  });

  const primary = ranked[0];
  const vendor = vendorOf(primary.name);
  const encoder = encoderFor(vendor);
  const softwareOnlyIntel = /uhd graphics|hd graphics|iris/i.test(primary.name) && !/arc|iris xe/i.test(primary.name);

  return {
    adapters: ranked,
    primary,
    vendor,
    encoder: softwareOnlyIntel ? 'x264' : encoder,
    hardware: Boolean(vendor) && !softwareOnlyIntel,
    description: describeGpu({ encoder: softwareOnlyIntel ? 'x264' : encoder }),
  };
}

module.exports = { detectGpu, listAdapters, vendorOf, encoderFor, describeGpu };
