'use strict';

const crypto = require('node:crypto');
const { findFilterName, FILTER_NAMES } = require('./filters');

function base64Sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

async function loadWs() {
  try {
    const mod = await import('ws');
    return mod.default || mod.WebSocket || mod;
  } catch {
    return null;
  }
}

class ObsClient {
  constructor({ host = '127.0.0.1', port = 4455, password = '', timeout = 8000 } = {}) {
    this.host = host;
    this.port = Number(port);
    this.password = password;
    this.timeout = timeout;
    this.ws = null;
    this.counter = 0;
    this.pending = new Map();
    this.identified = false;
    this.identifiedPromise = null;
    this.identifiedResolve = null;
  }

  async connect() {
    const Ws = await loadWs();
    if (!Ws) {
      throw new Error('Не найден модуль «ws». Выполни: npm install ws');
    }

    this.ws = new Ws(`ws://${this.host}:${this.port}`);
    this.identifiedPromise = new Promise((resolve) => {
      this.identifiedResolve = resolve;
    });

    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('error', (error) => this.rejectAll(error));
    this.ws.on('close', () => this.rejectAll(new Error('Соединение с OBS закрыто')));

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    const auth = await this.rpc('GetAuthRequired');
    const d = auth || {};
    if (d.authRequired) {
      if (!this.password) {
        throw new Error('obs-websocket включён с паролем. Укажи --password или отключи аутентификацию в OBS');
      }
      this.pendingAuth = base64Sha256(base64Sha256(this.password + d.salt) + d.challenge);
    }

    this.identified = false;
    this.send({ op: 1, d: { rpcVersion: 1, ...(this.pendingAuth ? { authentication: this.pendingAuth } : {}) } });
    await Promise.race([
      this.identifiedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OBS не подтвердил подключение (таймаут)')), this.timeout),
      ),
    ]);
    return this;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const data = message.d || {};

    if (message.op === 0) {
      this.obsWebSocketVersion = data.obsWebSocketVersion;
      this.rpcVersion = data.rpcVersion;
      const ident = { rpcVersion: data.rpcVersion || 1 };
      if (this.pendingAuth) ident.authentication = this.pendingAuth;
      this.send({ op: 1, d: ident });
      return;
    }

    if (message.op === 2) {
      if (this.identifiedResolve) this.identifiedResolve(data);
      this.identifiedResolve = null;
      return;
    }

    if (data['message-id']) {
      const entry = this.pending.get(data['message-id']);
      if (!entry) return;
      this.pending.delete(data['message-id']);
      if (data.status === 'ok' || data.results !== undefined) {
        entry.resolve(data);
      } else {
        entry.reject(new Error(data.comment || `${data.requestType} failed`));
      }
    }
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  rpc(requestType, data = {}) {
    this.counter += 1;
    const messageId = String(this.counter);
    const body = { ...data, requestType, messageId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Таймаут запроса ${requestType}`));
      }, this.timeout);
      this.pending.set(messageId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ op: 6, d: body });
    });
  }

  rejectAll(error) {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  async version() {
    const response = await this.rpc('GetVersion');
    return response || {};
  }

  async listInputs() {
    const response = await this.rpc('GetInputList');
    return (response && response.inputs) || [];
  }

  async listScenes() {
    const response = await this.rpc('GetSceneList');
    return (response && response.scenes) || [];
  }

  async resolveInput(name) {
    const inputs = await this.listInputs();
    const input = inputs.find((item) => String(item.inputName).toLowerCase() === String(name).toLowerCase());
    if (input) return input;
    const scenes = await this.listScenes();
    const scene = scenes.find((item) => String(item.sceneName).toLowerCase() === String(name).toLowerCase());
    return scene ? { inputName: scene.sceneName, inputKind: 'OBS_WEBSOCKET_INPUT_KIND_SCENE' } : null;
  }

  async listFilters(inputName) {
    const response = await this.rpc('GetInputFilterList', { inputName });
    return (response && response.filters) || [];
  }

  async ensureFilter(inputName, type) {
    const filters = await this.listFilters(inputName);
    const existing = findFilterName(filters, type);
    if (existing) return { name: existing, added: false };

    const candidates = FILTER_NAMES[type] || [];
    for (const filterName of candidates) {
      try {
        await this.rpc('AddInputFilter', { inputName, filterName });
        return { name: filterName, added: true };
      } catch {
        continue;
      }
    }
    throw new Error(`Не удалось добавить фильтр ${type} на «${inputName}» (нет подходящего имени в OBS)`);
  }

  async setFilterSettings(inputName, filterName, filterSettings) {
    await this.rpc('SetInputFilterSettings', {
      inputName,
      filterName,
      filterSettings,
      overlay: true,
    });
  }

  async reorder(inputName, order) {
    try {
      await this.rpc('ReorderInputFilter', { inputName, filterNames: order });
      return true;
    } catch {
      for (let index = 0; index < order.length; index += 1) {
        try {
          await this.rpc('ReorderInputFilter', { inputName, filterName: order[index], newIndex: index });
        } catch {
          return false;
        }
      }
      return true;
    }
  }

  async saveFilters() {
    for (const requestType of ['SaveSourceFilters', 'SaveInputFilters']) {
      try {
        await this.rpc(requestType, {});
        return requestType;
      } catch {
        continue;
      }
    }
    return null;
  }

  async applyChain(inputName, chain) {
    const applied = [];
    const names = [];

    for (const filter of chain) {
      const { name, added } = await this.ensureFilter(inputName, filter.type);
      await this.setFilterSettings(inputName, name, filter.settings);
      applied.push({ type: filter.type, name, added });
      names.push(name);
    }

    const current = await this.listFilters(inputName);
    const rest = current.map((filter) => filter.name).filter((name) => !names.includes(name));
    const reordered = await this.reorder(inputName, [...names, ...rest]);
    const saved = await this.saveFilters();

    return { applied, reordered, saved };
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

module.exports = { ObsClient };
