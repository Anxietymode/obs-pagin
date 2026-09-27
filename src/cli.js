#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { detectGpu } = require('./gpu');
const { plan, parseResolution, profilePatch } = require('./presets');
const obsProfile = require('./obs-profile');
const { buildChain, renderChain, renderAddFilterNames, CAPTURE_TIPS } = require('./filters');
const logcheck = require('./logcheck');
const { ObsClient } = require('./obsws');

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
};

function colorize(text, color) {
  return process.stdout.isTTY ? `${COLORS[color] || ''}${text}${COLORS.reset}` : text;
}

function heading(text) {
  console.log('');
  console.log(colorize(text, 'bold'));
  console.log(colorize('-'.repeat(text.length), 'dim'));
}

function table(rows) {
  const widths = rows.reduce(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] || 0, String(cell).length)),
    [],
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, index) => String(cell).padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    );
  }
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inlineValue] = token.slice(2).split('=');
      const name = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (inlineValue !== undefined) {
        args.flags[name] = inlineValue;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args.flags[name] = argv[i + 1];
        i += 1;
      } else {
        args.flags[name] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function resolveEncoder(flags) {
  if (flags.gpu) return String(flags.gpu).toLowerCase();
  return detectGpu().encoder;
}

function resolveProfileName(flags) {
  return flags.profile || 'Twitch 1080p60';
}

function resolveStream(flags) {
  const res = parseResolution(flags.res) || { width: 1920, height: 1080 };
  const fps = Number(flags.fps) || 60;
  return { ...res, fps };
}

function printPlan(planResult) {
  table([
    ['Параметр', 'Значение', 'Комментарий'],
    ['Кодировщик', planResult.encoderLabel, planResult.encoder === 'x264' ? 'нагружает CPU' : 'аппаратный'],
    ['Разрешение', `${planResult.width}x${planResult.height}`, `режим стрима: ${planResult.streamLabel}`],
    ['Частота кадров', String(planResult.fps), 'как в игре, без дублей'],
    ['Управление битрейтом', planResult.rateControl, planResult.isTwitch ? 'для Twitch только CBR' : 'CBR — меньше артефактов'],
    ['Битрейт (видео)', `${planResult.bitrate} kbps`, planResult.isTwitch ? 'максимум Twitch 6000' : `сервис: ${planResult.software}`],
    ['Интервал ключевых кадров', `2 сек (${planResult.gop} кадров)`, planResult.isTwitch ? 'обязательно для Twitch' : 'нужно для быстрого старта'],
    ['B-кадры', String(planResult.bframes), '0, если кодировщик не успевает'],
    ['Битрейт аудио', `${planResult.audioBitrate} kbps / ${planResult.audioChannels} канала`, 'AAC, без пиков выше 0 dB'],
  ]);

  if (planResult.presetHint) {
    console.log('');
    console.log(`Пресет: ${planResult.presetHint}`);
  }

  console.log('');
  console.log(colorize('Что выставить вручную в OBS (Настройки -> Вывод):', 'cyan'));
  for (const step of planResult.uiSteps) console.log(`  1. ${step}`);
  for (const extra of planResult.extra) console.log(`  1. (${extra})`);

  if (planResult.warnings.length) {
    console.log('');
    console.log(colorize('Предупреждения:', 'yellow'));
    for (const warning of planResult.warnings) console.log(`  ! ${warning}`);
  }
}

function printFilterNames(chain) {
  console.log('Если фильтры добавляешь руками, называются так:');
  for (const line of renderAddFilterNames(chain)) console.log(`  ${line}`);
}

async function commandFilters(flags) {
  const stream = resolveStream(flags);
  const capture = parseResolution(flags.capture) || { width: stream.width, height: stream.height };
  const chain = buildChain({
    streamWidth: stream.width,
    streamHeight: stream.height,
    captureWidth: capture.width,
    captureHeight: capture.height,
    fps: stream.fps,
    sharpen: flags.sharpen !== undefined ? Number(flags.sharpen) : null,
    interlaced: Boolean(flags.interlaced),
    gameCapture: Boolean(flags.game),
    webcam: Boolean(flags.webcam),
  });

  const target = String(flags.target || 'Сцена (или название источника)');
  const captureDiffers = capture.width !== stream.width || capture.height !== stream.height;

  heading(`Цепочка фильтров качества: ${stream.width}x${stream.height}@${stream.fps}`);
  if (captureDiffers) {
    console.log(colorize(`Источник: ${capture.width}x${capture.height} (масштабирование вниз)`, 'dim'));
  }
  console.log('');
  for (const line of renderChain(chain, { target })) console.log(line);

  if (captureDiffers) {
    console.log(colorize('Захват:', 'cyan'));
    console.log('  1. Базовое разрешение и холст = разрешению трансляции, полный экран');
    console.log('  1. В свойствах источника включи «Принудительное масштабирование на GPU»');
    console.log('  1. Формат: NV12, 8 бит, 4:2:0');
    console.log('');
  }

  console.log(colorize('Базовые настройки захвата (важнее любых фильтров):', 'cyan'));
  CAPTURE_TIPS.forEach((tip, index) => console.log(`  ${index + 1}. ${tip}`));
  console.log('');
  printFilterNames(chain);

  if (!flags.apply) {
    console.log('');
    console.log(colorize('Это только план. Применить автоматически:', 'dim'));
    console.log(colorize('  node src/cli.js filters --apply --target "Сцена" [--password ТВОЙ_ПАРОЛЬ]', 'dim'));
    console.log(colorize('Нужен включённый obs-websocket: OBS -> Сервис -> Веб-сервер obs-websocket (порт 4455).', 'dim'));
    return;
  }

  const client = new ObsClient({
    host: String(flags.host || '127.0.0.1'),
    port: Number(flags.port || 4455),
    password: String(flags.password || ''),
  });

  try {
    await client.connect();
  } catch (error) {
    if (/ECONNREFUSED/.test(error.message)) {
      throw new Error(
        'Не удалось подключиться к obs-websocket.\n' +
          '  1. Запусти OBS.\n' +
          '  2. OBS -> Сервис -> Веб-сервер obs-websocket -> Включить (порт 4455).\n' +
          '  3. Повтори команду. Если включена аутентификация, добавь --password.',
      );
    }
    throw error;
  }

  const version = await client.version();
  console.log('');
  console.log(colorize(`Подключено к OBS ${version.obsWebSocketVersion || ''} (rpc ${version.rpcVersion || '?'})`, 'green'));

  const input = await client.resolveInput(target);
  if (!input) {
    const inputs = await client.listInputs();
    const scenes = await client.listScenes();
    client.close();
    throw new Error(
      `Источник «${target}» не найден. Доступные сцены: ${scenes.map((s) => s.sceneName).join(', ') || 'нет'}\n` +
        `Источники: ${inputs.map((i) => i.inputName).join(', ') || 'нет'}`,
    );
  }

  const result = await client.applyChain(input.inputName, chain);
  client.close();

  for (const item of result.applied) {
    console.log(`  ${item.added ? '+' : ' '} ${item.name}${item.added ? ' (добавлен)' : ' (настроен)'}`);
  }
  console.log('');
  console.log(colorize(result.saved ? 'Фильтры применены и сохранены в наборе сцен.' : 'Фильтры применены (сохранение — Ctrl+S в OBS).', 'green'));
}

function commandProfile(flags) {
  const encoder = resolveEncoder(flags);
  const stream = resolveStream(flags);
  const bitrate = flags.bitrate ? Number(flags.bitrate) : undefined;
  const planResult = plan({ encoder, ...stream, bitrate, software: flags.software || 'Twitch' });
  const profileName = resolveProfileName(flags);

  heading('План кодировщика и битрейта');
  printPlan(planResult);

  const patch = profilePatch(planResult);
  heading(`Профиль OBS: ${profileName}`);
  const existingProfiles = obsProfile.listProfiles();
  console.log(`Существующие профили: ${existingProfiles.length ? existingProfiles.join(', ') : colorize('ни одного', 'yellow')}`);
  console.log(`Файл: ${obsProfile.profileFile(profileName)}`);

  const running = obsProfile.isObsRunning();
  if (running) console.log(colorize('OBS сейчас запущена — закрой её перед применением.', 'yellow'));

  if (!flags.apply) {
    console.log('');
    console.log(colorize('Сухим прогоном. Записать в профиль:', 'dim'));
    console.log(colorize('  node src/cli.js profile --apply', 'dim'));
    return;
  }

  const result = obsProfile.writeProfile({ profileName, patch, apply: true });
  if (running) {
    throw new Error('OBS запущена. Закрой OBS и повтори --apply, иначе настройки перезапишутся при её закрытии.');
  }

  console.log('');
  for (const change of result.changes) {
    const before = change.before === null ? '—' : change.before;
    console.log(`  [${change.section}] ${change.key}: ${before} -> ${colorize(String(change.value), 'green')}`);
  }
  if (result.backup) console.log(`  backup: ${result.backup}`);
  console.log('');
  console.log(colorize(`Записано: ${result.file}`, 'green'));
  console.log(colorize('Дальше открой OBS -> Вывод -> Битрейт трансляции: используй значения из плана.', 'dim'));
}

function commandDoctor() {
  heading('Диагностика окружения');
  const gpu = detectGpu();

  table([
    ['Параметр', 'Значение'],
    ['GPU', gpu.primary ? `${gpu.primary.name}` : 'не определён'],
    ['Драйвер', gpu.primary ? gpu.primary.driver : '—'],
    ['Рекомендованный кодировщик', gpu.description],
  ]);

  if (gpu.adapters.length > 1) {
    console.log('');
    console.log('Другие адаптеры:');
    for (const adapter of gpu.adapters.slice(1)) console.log(`  - ${adapter.name}`);
  }

  const root = obsProfile.obsRoot();
  heading('OBS');
  const profiles = obsProfile.listProfiles();
  table([
    ['Параметр', 'Значение'],
    ['Папка настроек', root],
    ['OBS установлена (настройки найдены)', fsExists(root) ? 'да' : colorize('нет', 'yellow')],
    ['Профили', profiles.length ? profiles.join(', ') : colorize('нет', 'yellow')],
    ['OBS запущена', obsProfile.isObsRunning() ? 'да' : 'нет'],
  ]);

  if (profiles.length) {
    const settings = obsProfile.currentSettings(profiles[0]);
    const out = settings.Output || {};
    console.log('');
    console.log(`Текущие настройки вывода (профиль «${profiles[0]}»):`);
    table([
      ['Ключ', 'Значение'],
      ['Mode', out.Mode || '—'],
      ['RecRateEncoder', out.RecRateEncoder || '—'],
      ['RecRate', out.RecRate || '—'],
      ['RecRateControl', out.RecRateControl || '—'],
      ['RecGopSize', out.RecGopSize || '—'],
      ['RecBF', out.RecBF || '—'],
    ]);
  }

  const wsConfig = path.join(root, 'plugin_config', 'obs-websocket', 'config.json');
  console.log('');
  console.log(colorize(`obs-websocket config: ${fsExists(wsConfig) ? wsConfig : colorize('не найден — фильтры придётся добавлять вручную', 'yellow')}`, 'dim'));
}

function fsExists(p) {
  return fs.existsSync(p);
}

function commandCheck(flags) {
  heading('Разбор лога OBS');
  const result = logcheck.readAndAnalyze(flags.log || (flags._ && flags._[0]));
  console.log(`Файл: ${result.file || '—'}`);
  if (result.stats && Object.keys(result.stats).length) {
    console.log('');
    table([
      ['Статистика', 'Значение'],
      ...Object.entries(result.stats).map(([key, value]) => [key, String(value)]),
    ]);
  }
  console.log('');
  for (const finding of result.findings) {
    const color = finding.level === 'error' ? 'red' : finding.level === 'warn' ? 'yellow' : 'green';
    console.log(`${colorize(finding.level.toUpperCase(), color)} ${finding.title}`);
    console.log(`  -> ${finding.fix}`);
  }
}

function commandAll(flags) {
  commandDoctor();
  commandProfile({ ...flags, apply: false });
  return commandFilters({ ...flags, apply: false });
}

const HELP = `
obs-tuner — качество картинки OBS для Twitch

Команды:
  doctor              определить GPU, кодировщик, показать профили OBS
  plan                рекомендованные настройки кодировщика и битрейта
  profile             то же + записать настройки в профиль OBS (--apply)
  filters             цепочка фильтров качества (--apply — применить в запущенной OBS)
  check               разбор последнего лога OBS: дропы кадров и ошибки энкодера
  all                 doctor + plan + filters одним прогоном

Общие флаги:
  --gpu nvenc|amd|qsv|x264   принудительный кодировщик
  --res 1920x1080            разрешение трансляции
  --fps 60                   частота кадров
  --bitrate 6000             битрейт видео, kbps
  --software Twitch          сервис (для не-Twitch лимит битрейта выше)
  --profile "Twitch 1080p60" имя профиля OBS

profile:
  --apply                    записать в basic.ini (OBS должна быть закрыта)

filters:
  --target "Сцена"           название сцены/источника
  --capture 2560x1440        разрешение источника, если оно выше стрима
  --sharpen 0.15             сила фильтра резкости (0 — выключить)
  --interlaced               источник чересстрочный
  --game                     добавить фильтр мерцания для захвата игры
  --webcam                   добавить шумоподавление вебки (нужен NVIDIA Broadcast)
  --apply                    применить через obs-websocket
  --host / --port / --password  подключение к obs-websocket (по умолчанию 127.0.0.1:4455)

check:
  --log path/to/log.txt      свой файл лога вместо последнего

Примеры:
  node src/cli.js all
  node src/cli.js profile --apply --profile "Twitch 1080p60"
  node src/cli.js filters --apply --target "Сцена" --capture 2560x1440
  node src/cli.js check
`;

async function main() {
  const argv = process.argv.slice(2);
  const { _: positional, flags } = parseArgs(argv);
  const command = positional[0] || 'all';

  const table_ = {
    doctor: () => commandDoctor(),
    plan: () => commandProfile({ ...flags, apply: false }),
    profile: () => commandProfile(flags),
    filters: () => commandFilters(flags),
    check: () => commandCheck({ ...flags, _: positional.slice(1) }),
    all: () => commandAll(flags),
    help: () => console.log(HELP),
  };

  const handler = table_[command];
  if (!handler) {
    console.log(colorize(`Неизвестная команда: ${command}`, 'red'));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  await handler();
}

main().catch((error) => {
  console.error('');
  console.error(colorize('Ошибка: ', 'red') + error.message);
  process.exitCode = 1;
});
