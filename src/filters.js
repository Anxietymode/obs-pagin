'use strict';

const FILTER_NAMES = {
  scale_filter: ['Scale Filter', 'Масштабный фильтр', 'Filter масштаба'],
  sharpen_filter: ['Sharpen Filter', 'Фильтр резкости', 'Резкость'],
  color_filter: ['Color Correction', 'Коррекция цвета', 'Цветокоррекция'],
  deinterlace_filter: ['Deinterlace Filter', 'Фильтр деинтерлейса', 'Деинтерлейс'],
  anti_flicker_filter: ['Anti-Flicker Filter', 'Фильтр мерцания', 'Anti-Flicker'],
  noise_suppression_filter: ['Noise Suppression', 'Noise Suppression Filter', 'Шумоподавление'],
};

function findFilterName(list, type) {
  const candidates = FILTER_NAMES[type] || [];
  const match = (list || []).find((filter) => {
    const name = String(filter.name || '').toLowerCase();
    const filterType = String(filter.type || '').toLowerCase();
    if (filterType && filterType === type.toLowerCase()) return true;
    return candidates.some((candidate) => candidate.toLowerCase() === name);
  });
  return match ? match.name : null;
}

function buildChain(options = {}) {
  const {
    streamWidth = 1920,
    streamHeight = 1080,
    captureWidth = streamWidth,
    captureHeight = streamHeight,
    fps = 60,
    sharpen = null,
    interlaced = false,
    gameCapture = false,
    webcam = false,
  } = options;

  const chain = [];
  const downscaling = captureWidth > streamWidth || captureHeight > streamHeight;

  if (downscaling) {
    chain.push({
      type: 'scale_filter',
      label: 'Масштабный фильтр',
      settings: {
        filter: 'lanczos',
        resolution: `${streamWidth}x${streamHeight}`,
      },
      why: `Источник ${captureWidth}x${captureHeight} -> стрим ${streamWidth}x${streamHeight}. Lanczos даёт резче билинейного и не мылит детали.`,
    });
  }

  const sharpenAmount = sharpen === null ? (downscaling ? 0.15 : 0.1) : Number(sharpen);
  if (sharpenAmount > 0) {
    chain.push({
      type: 'sharpen_filter',
      label: 'Фильтр резкости',
      settings: { amount: sharpenAmount },
      why: 'Мягкая резкость после масштабирования. Выше 0.25 появляются ореолы и мыло на тёмных сценах.',
    });
  }

  chain.push({
    type: 'color_filter',
    label: 'Коррекция цвета',
    settings: {
      brightness: 0,
      contrast: 1.02,
      gamma: 1,
      hue_shift: 0,
      saturation: 1.03,
    },
    why: 'Чуть поднятые контраст и насыщенность — картинка читается лучше на телефонах после сжатия Twitch.',
  });

  if (interlaced) {
    chain.push({
      type: 'deinterlace_filter',
      label: 'Фильтр деинтерлейсинга',
      settings: { mode: 'auto', algorithm: 'yadif2x' },
      why: 'Источник чересстрочный, без этого будут «гребёнки» в движении.',
    });
  }

  if (gameCapture) {
    chain.push({
      type: 'anti_flicker_filter',
      label: 'Фильтр мерцания',
      settings: { amount: 0.5, filter: 'dup' },
      onlyFor: 'Game Capture',
      why: 'Убирает мерцание от HDR/шейдеров. Ставить только на источник захвата игры, не на весь сцену.',
    });
  }

  if (webcam) {
    chain.push({
      type: 'noise_suppression_filter',
      label: 'Noise Suppression (нужен плагин NVIDIA Broadcast)',
      settings: {},
      optional: true,
      why: 'Убирает шум с веб-камеры. Требует плагина NVIDIA Broadcast Effects — если его нет, пропусти шаг.',
    });
  }

  return chain;
}

const CAPTURE_TIPS = [
  'Выход (Настройки -> Видео): Базовое разрешение = холст, а холст = разрешению трансляции. Никогда не растягивай 720p до 1080p — будет мыло.',
  'Источник видеозахвата или Дисплей: включи «Принудительное масштабирование на GPU» (Force GPU rescaling) — снимает нагрузку с CPU и мыло на тексте.',
  'Захват игры: формат NV12, 8 бит, 4:2:0. 10 бит и 4:4:4 Twitch не поддерживает, только жрёт битрейт.',
  'Частота кадров: поставь целевую (60/30) в Настройки->Видео, а не в свойствах источника, иначе OBS будет дублировать кадры.',
  'Кодирование: x264 — только как последний вариант. Аппаратный кодировщик освобождает CPU и даёт стабильные 60 FPS.',
  'Аудио: 160 kbps, 2 канала. Ставь нормализацию звука, но пиковый лимитер выше 0 dB — иначе хрипы.',
  'Расширенный -> сетевой: «Динамический битрейт» выкл, для Twitch оставь CBR без резерва.',
  'Проверяй результат локальной записью (mkv, CRF 18) — так видно реальное качество до сжатия Twitch.',
];

function renderChain(chain, { target = 'Scene' } = {}) {
  const lines = [];
  lines.push(`Цепочка фильтров для источника «${target}»:`);
  lines.push('');

  chain.forEach((filter, index) => {
    lines.push(`${index + 1}. ${filter.label} (${filter.type})`);
    if (filter.onlyFor) lines.push(`   только для: ${filter.onlyFor}`);
    if (filter.optional) lines.push('   необязательный, пропусти если нет плагина');
    const settings = Object.entries(filter.settings)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    if (settings) lines.push(`   параметры: ${settings}`);
    lines.push(`   зачем: ${filter.why}`);
    lines.push('');
  });

  if (!chain.length) lines.push('Фильтры не требуются: источник уже в разрешении трансляции.');
  return lines;
}

function renderAddFilterNames(chain) {
  const lines = [];
  for (const filter of chain) {
    const names = FILTER_NAMES[filter.type] || [];
    const label = filter.onlyFor ? `${filter.label} (только ${filter.onlyFor})` : filter.label;
    lines.push(`- ${label}: «${names[0]}»${names[1] ? ` / «${names[1]}»` : ''}`);
  }
  return lines;
}

module.exports = { FILTER_NAMES, buildChain, renderChain, renderAddFilterNames, findFilterName, CAPTURE_TIPS };
