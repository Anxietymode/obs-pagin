'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { obsRoot } = require('./obs-profile');

function latestLog(explicitPath) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) throw new Error(`Файл лога не найден: ${explicitPath}`);
    return explicitPath;
  }
  const dir = path.join(obsRoot(), 'logs');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .map((name) => {
      const full = path.join(dir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].full : null;
}

const RULES = [
  {
    id: 'encoder-fail',
    test: /(failed to (initialize|open|start)|encoder .*(error|failed|not available)|no (supported )?encoder|could not start encoder)/i,
    level: 'error',
    title: 'Энкодер не стартовал',
    fix: 'В Настройки->Вывод смени кодировщик: NVENC (NVIDIA), AMD AMF, Intel QSV. Если ничего не помогает — x264 с пресетом veryfast.',
  },
  {
    id: 'nvenc-smi',
    test: /please run 'nvidia-smi'/i,
    level: 'error',
    title: 'Драйвер NVIDIA в неподходящем режиме',
    fix: 'Обнови драйвер до Studio-версии, потом запусти nvidia-smi -q | grep Persistence и верни Persistence-Mode: Enabled.',
  },
  {
    id: 'display-capture',
    test: /failed to open the display capture|graphics capture|display capture failed/i,
    level: 'warn',
    title: 'Захват дисплея не удался',
    fix: 'Запусти OBS от администратора или используй Захват игры + Захват окна (без переключений на рабочий стол).',
  },
  {
    id: 'audio-fail',
    test: /(audio.*(device|output).*(failed|not found|unavailable))|wasb error|invalid device/i,
    level: 'warn',
    title: 'Проблема с аудиоустройством',
    fix: 'Проверь Настройки->Аудио: устройство вывода/захвата и 160 kbps стерео. Смотри также Конфигурация окна -> Динамики.',
  },
  {
    id: 'high-cpu',
    test: /high cpu usage|encoder overloaded|remuxing took|cannot run the OBS application/i,
    level: 'warn',
    title: 'Перегрузка CPU',
    fix: 'Включи аппаратный кодировщик, отключи лишние источники, не запускай захват окна браузера вместе с захватом игры.',
  },
  {
    id: 'network',
    test: /(connection (interrupted|lost)|network.*(error|failed)|socket.*(closed|error))/i,
    level: 'warn',
    title: 'Проблемы с сетью',
    fix: 'Проверь апстрим: Ethernet, 60+ Мбит/с свободных, в Настройки->Вывод оставь только «Динамический битрейт: выкл» для Twitch.',
  },
];

function countStats(text) {
  const stats = {};

  const dropped = /Number of dropped frames:\s*(\d+)/i.exec(text);
  if (dropped) stats.droppedFrames = Number(dropped[1]);

  const skipped = /Number of skipped frames due to encoding:\s*(\d+)/i.exec(text);
  if (skipped) stats.skippedByEncoder = Number(skipped[1]);

  const netDropped = /Number of dropped frames \(due to network\):\s*(\d+)/i.exec(text);
  if (netDropped) stats.droppedByNetwork = Number(netDropped[1]);

  const rendered = /([\d.]+)\s*secs? (?:spent )?rendering/i.exec(text);
  if (rendered) stats.secondsRendering = Number(rendered[1]);

  const encoded = /([\d.]+)\s*secs? (?:spent )?encoding/i.exec(text);
  if (encoded) stats.secondsEncoding = Number(encoded[1]);

  const statsLine = /=====\s*Video statistics\s*=====/i.test(text);
  if (statsLine) stats.hasStatistics = true;

  const totalFrames = /Total frames rendered:\s*(\d+)/i.exec(text);
  if (totalFrames) stats.totalFrames = Number(totalFrames[1]);

  return stats;
}

function analyze(text) {
  const findings = [];
  const stats = countStats(text);

  for (const rule of RULES) {
    const match = rule.test.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ level: rule.level, title: rule.title, fix: rule.fix, line });
    }
  }

  const frames = stats.totalFrames || 0;

  if (stats.skippedByEncoder > 0 || (frames && stats.skippedByEncoder / frames > 0.001)) {
    findings.push({
      level: 'warn',
      title: `Пропущено кадров кодировщиком: ${stats.skippedByEncoder}`,
      fix: 'Не хватает мощности энкодера. NVENC/AMF/QSV, пресет Balanced/Quality, FPS 60, проверь температуру GPU.',
    });
  }
  if (stats.droppedByNetwork > 0) {
    findings.push({
      level: 'warn',
      title: `Потеряно кадров из-за сети: ${stats.droppedByNetwork}`,
      fix: 'Кабель Ethernet, проверь апстрим, не запускай торренты/обновления во время эфира.',
    });
  }
  if (frames && stats.droppedFrames / frames > 0.005) {
    findings.push({
      level: 'warn',
      title: `Пропущено кадров на выходе: ${stats.droppedFrames}`,
      fix: 'Снизь пресет энкодера или битрейт на 10-15%, закрой фоновые приложения, отключи оверлеи с большой нагрузкой.',
    });
  }
  if (stats.secondsRendering > 0 && stats.secondsEncoding > 0 && frames > 0) {
    const ratio = stats.secondsRendering / frames;
    if (ratio > 0.008) {
      findings.push({
        level: 'warn',
        title: `Рендер медленный: ${(ratio * 1000).toFixed(1)} мс на кадр`,
        fix: 'Цель — до 8 мс на кадр при 60 FPS. Включи масштабирование на GPU, упрости фильтры и оверлеи.',
      });
    }
  }

  if (!findings.length) {
    findings.push({
      level: 'ok',
      title: 'Критичных проблем в логе не найдено',
      fix: 'Сравни картинку с локальной записью (mkv, CRF 18) — остаток артефактов добавит сжатие Twitch.',
    });
  }

  return { stats, findings };
}

function readAndAnalyze(explicitPath) {
  const file = latestLog(explicitPath);
  if (!file) {
    return {
      file: null,
      stats: {},
      findings: [
        {
          level: 'warn',
          title: 'Логи OBS не найдены',
          fix: 'Запусти OBS, начни запись эфира и повтори: node src/cli.js check',
        },
      ],
    };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { file, ...analyze(text) };
}

module.exports = { latestLog, readAndAnalyze, analyze, countStats };
