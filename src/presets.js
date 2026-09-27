'use strict';

const TWITCH_LIMITS = [
  { width: 1920, height: 1080, fps: 60, bitrate: 6000, label: '1080p60' },
  { width: 1920, height: 1080, fps: 30, bitrate: 6000, label: '1080p30' },
  { width: 1600, height: 900, fps: 60, bitrate: 3500, label: '900p60' },
  { width: 1280, height: 720, fps: 60, bitrate: 4500, label: '720p60' },
  { width: 1280, height: 720, fps: 30, bitrate: 4500, label: '720p30' },
  { width: 852, height: 480, fps: 60, bitrate: 2500, label: '480p60' },
  { width: 640, height: 360, fps: 60, bitrate: 1000, label: '360p60' },
];

const ENCODERS = {
  nvenc: {
    id: 'nvenc',
    label: 'NVIDIA NVENC (h.264)',
    rateControl: 'CBR',
    preset: { key: 'RecPreset', value: 'p5', ui: 'Quality / p5 (Preset: Quality)' },
    extra: ['RecPreset=p5', 'RecQPI=23 (CQP только если выберешь CQP вместо CBR)'],
    uiSteps: [
      'Кодировщик: NVIDIA NVENC',
      'Управление битрейтом: CBR',
      'Пресет: Quality (p5)',
      'Профиль: high',
      'B-кадры: 2',
      'Пресет настройки: 0 (off)',
      'Повтор кадров: выкл',
      'Look-ahead: выкл',
      'Формат: NV12 (8 бит, 4:2:0)',
    ],
  },
  amd: {
    id: 'amd',
    label: 'AMD AMF (h.264)',
    rateControl: 'CBR',
    preset: null,
    extra: [],
    uiSteps: [
      'Кодировщик: AMD AMF',
      'Управление битрейтом: CBR',
      'Пресет: Quality (или Balanced на слабом ПК)',
      'B-кадры: 2',
      'Предварительный анализ: 1 кадр',
      'Повтор кадров: выкл',
      'Формат: NV12 (8 бит, 4:2:0)',
    ],
  },
  qsv: {
    id: 'qsv',
    label: 'Intel Quick Sync (h.264)',
    rateControl: 'CBR',
    preset: null,
    extra: [],
    uiSteps: [
      'Кодировщик: Intel Quick Sync',
      'Управление битрейтом: CBR',
      'Пресет: Quality (Balanced — если QSV не тянет 1080p60)',
      'Профиль: high',
      'B-кадры: 2',
      'Повтор кадров: выкл',
      'Формат: NV12 (8 бит, 4:2:0)',
    ],
  },
  x264: {
    id: 'x264',
    label: 'x264 (программный, CPU)',
    rateControl: 'CBR',
    preset: { key: 'FFVPreset', value: 'veryfast', ui: ' ultrafast/veryfast' },
    extra: ['FFVPreset=veryfast', 'FFVProfile=high', 'tune=zerolatency не нужен для стрима'],
    uiSteps: [
      'Кодировщик: x264',
      'Управление битрейтом: CBR',
      'Пресет: veryfast (ultrafast, если совсем слабый CPU)',
      'Профиль: high',
      'B-кадры: 2 (0, если процессор не успевает)',
      'Повтор кадров: выкл',
    ],
  },
};

function parseResolution(input) {
  const match = /^(\d{3,4})\s*[xX*]\s*(\d{3,4})$/.exec(String(input || '').trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function pickLimit(width, height, fps) {
  const candidates = TWITCH_LIMITS.filter((limit) => limit.height === height);
  const pool = candidates.length ? candidates : TWITCH_LIMITS;
  return pool.find((limit) => limit.fps === fps) || pool[0];
}

function plan({ encoder = 'x264', width = 1920, height = 1080, fps = 60, bitrate, software = 'Twitch' }) {
  const spec = ENCODERS[encoder] || ENCODERS.x264;
  const limit = pickLimit(width, height, fps);
  const isTwitch = software === 'Twitch';
  const defaultBitrate = isTwitch ? limit.bitrate : (limit.height >= 1080 ? 20000 : 12000);
  const clampedBitrate = Math.min(bitrate || defaultBitrate, isTwitch ? 6000 : 60000);

  return {
    software,
    isTwitch,
    encoder: spec.id,
    encoderLabel: spec.label,
    width,
    height,
    fps,
    outputLabel: `${width}x${height}@${fps}`,
    streamLabel: limit.label,
    bitrate: clampedBitrate,
    gop: fps * 2,
    bframes: 2,
    rateControl: isTwitch ? spec.rateControl : 'VBR',
    preset: spec.preset,
    presetHint: spec.ui,
    audioBitrate: 160,
    audioChannels: 2,
    uiSteps: spec.uiSteps,
    extra: spec.extra,
    warnings: buildWarnings({ width, height, fps, clampedBitrate, limit, encoder: spec.id, software }),
  };
}
function buildWarnings({ width, height, fps, clampedBitrate, limit, encoder, software }) {
  const warnings = [];

  if (width !== limit.width || height !== limit.height) {
    warnings.push(
      `Разрешение ${width}x${height} не совпадает с режимом Twitch ${limit.label}: холст и трансляцию поставь ${limit.width}x${limit.height}, иначе картинку будет пересчитывать OBS.`,
    );
  }
  if (clampedBitrate < limit.bitrate) {
    warnings.push(
      `Битрейт ${clampedBitrate} kbps ниже рекомендованных ${limit.bitrate} kbps для ${limit.label} — будут мыло и блоки в динамике.`,
    );
  }
  if (encoder === 'x264' && (width >= 1920 || fps >= 60)) {
    warnings.push(
      'x264 на 1080p60 сильно грузит процессор и обычно не тянет 60 FPS без дропов — лучше включить аппаратный кодировщик (NVENC/AMF/QSV).',
    );
  }
  if (software !== 'Twitch') {
    warnings.push('Для не-Twitch платформ битрейт можно ставить выше (20000-35000), если позволяет канал.');
  }
  if (fps >= 60 && width >= 1920) {
    warnings.push(
      software === 'Twitch'
        ? '1080p60 требует ~6000 kbps и 60 FPS без повторов кадров: в настройках видео поставь частоту кадров 60, а «Повтор кадров» выключи.'
        : '1080p60 требует 60 FPS без повторов кадров: частоту кадров ставь в Настройки->Видео, а «Повтор кадров» выключи.',
    );
  }
  return warnings;
}

function profilePatch(planResult) {
  const patch = {
    Output: {
      Mode: 'Advanced',
      RecMode: '0',
      RecRate: String(planResult.bitrate),
      RecRateEncoder: planResult.encoder,
      RecRateControl: planResult.rateControl,
      RecGopSize: String(planResult.gop),
      RecBF: String(planResult.bframes),
      RecBFAvgSec: '0',
    },
  };

  if (planResult.preset && planResult.preset.key) {
    patch.Output[planResult.preset.key] = planResult.preset.value;
  }
  if (planResult.encoder === 'x264') {
    patch.Output.FFVProfile = 'high';
  }

  patch.Stream = {
    CustomStreamXRes: String(planResult.width),
    CustomStreamYRes: String(planResult.height),
    CustomStreamFps: String(planResult.fps),
    CustomStreamBitrate: String(planResult.bitrate),
  };

  return patch;
}

module.exports = {
  TWITCH_LIMITS,
  ENCODERS,
  parseResolution,
  pickLimit,
  plan,
  profilePatch,
};
