/**
 * PlasticBack — локальное хранилище (LocalStorage).
 * Отвечает за загрузку, валидацию, восстановление и сохранение состояния.
 */
(function (global) {
  'use strict';

  var PB = global.PlasticBack;
  var cfg = PB.config;
  var trackerLogic = PB.tracker;

  var KEY = cfg.storage.key;
  var BACKUP_KEY = cfg.storage.backupKey;
  var VERSION = cfg.storage.version;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  var available = null;
  var memoryCopy = null; // используется, если LocalStorage недоступен

  function isAvailable() {
    if (available !== null) return available;
    try {
      var probe = '__pb_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      available = true;
    } catch (e) {
      available = false;
    }
    return available;
  }

  /** Анонимный UUID v4. Не является средством аутентификации. */
  function generateId() {
    var c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') {
      c.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) {
      return (b + 0x100).toString(16).slice(1);
    }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function defaultQuantities() {
    var q = {};
    cfg.drinks.forEach(function (d) { q[d.id] = d.defaultQuantity || 0; });
    return q;
  }

  function createDefaultState() {
    return {
      version: VERSION,
      userId: generateId(),
      createdAt: new Date().toISOString(),
      calculator: {
        quantities: defaultQuantities(),
        settings: { hasCalculated: false, updatedAt: null }
      },
      tracker: trackerLogic.createEmpty(null),
      sync: { pending: [] }
    };
  }

  function isValidDate(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
    var parts = value.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
  }

  function toFiniteNumber(value, min, max) {
    var n = Number(value);
    if (typeof value === 'boolean' || value === null || value === '' || !isFinite(n)) return null;
    if (n < min || n > max) return null;
    return n;
  }

  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isValidDate(raw.date)) return null;
    var amount = toFiniteNumber(raw.amount, 0, cfg.limits.maxDailyAmount);
    var bottles = toFiniteNumber(raw.plasticBottles, 0, cfg.limits.maxDailyWasteItems);
    var packages = toFiniteNumber(raw.packages, 0, cfg.limits.maxDailyWasteItems);
    if (amount === null || bottles === null || packages === null) return null;
    return { date: raw.date, amount: amount, plasticBottles: bottles, packages: Math.round(packages) };
  }

  function sanitizePending(raw) {
    if (!raw || typeof raw !== 'object' || !isValidDate(raw.date)) return null;
    var amount = toFiniteNumber(raw.amount, 0, cfg.limits.maxDailyAmount);
    var waste = toFiniteNumber(raw.wasteItems, 0, cfg.limits.maxDailyWasteItems);
    if (amount === null || waste === null) return null;
    return { date: raw.date, amount: amount, wasteItems: Math.round(waste) };
  }

  /**
   * Проверяет и восстанавливает данные. Отсутствующие необязательные поля
   * заполняются значениями по умолчанию, повреждённые — отбрасываются.
   */
  function sanitize(raw) {
    var base = createDefaultState();
    var repaired = false;

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { state: base, repaired: true };
    }

    var state = base;

    if (typeof raw.userId === 'string' && UUID_RE.test(raw.userId)) {
      state.userId = raw.userId.toLowerCase();
    } else {
      repaired = true;
    }

    if (typeof raw.createdAt === 'string' && !isNaN(Date.parse(raw.createdAt))) {
      state.createdAt = raw.createdAt;
    }

    // Калькулятор
    var calc = raw.calculator && typeof raw.calculator === 'object' ? raw.calculator : null;
    if (calc && calc.quantities && typeof calc.quantities === 'object') {
      cfg.drinks.forEach(function (d) {
        if (!Object.prototype.hasOwnProperty.call(calc.quantities, d.id)) return;
        var v = toFiniteNumber(calc.quantities[d.id], cfg.slider.min, cfg.slider.max);
        if (v === null) {
          repaired = true;
          state.calculator.quantities[d.id] = 0;
        } else {
          state.calculator.quantities[d.id] = Math.round(v);
        }
      });
    } else if (raw.calculator !== undefined) {
      repaired = true;
    }
    if (calc && calc.settings && typeof calc.settings === 'object') {
      state.calculator.settings.hasCalculated = calc.settings.hasCalculated === true;
      if (typeof calc.settings.updatedAt === 'string') state.calculator.settings.updatedAt = calc.settings.updatedAt;
    }

    // Трекер: итоги всегда пересчитываются из истории
    var tr = raw.tracker && typeof raw.tracker === 'object' ? raw.tracker : null;
    if (tr) {
      var seen = {};
      var history = [];
      (Array.isArray(tr.history) ? tr.history : []).forEach(function (item) {
        var entry = sanitizeEntry(item);
        if (!entry || seen[entry.date]) { repaired = true; return; }
        seen[entry.date] = true;
        history.push(entry);
      });
      if (tr.history !== undefined && !Array.isArray(tr.history)) repaired = true;
      history.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (history.length > cfg.tracker.maxHistoryEntries) {
        history = history.slice(-cfg.tracker.maxHistoryEntries);
      }

      var totals = trackerLogic.recalcTotals(history);
      var storedTotal = Number(tr.totalSaved);
      if (isFinite(storedTotal) && Math.abs(storedTotal - totals.totalSaved) > 0.01) repaired = true;

      var lastDate = isValidDate(tr.lastAccrualDate) ? tr.lastAccrualDate : null;
      var latestHistory = history.length ? history[history.length - 1].date : null;
      if (latestHistory && (!lastDate || latestHistory > lastDate)) lastDate = latestHistory;

      state.tracker = {
        history: history,
        totalSaved: totals.totalSaved,
        wasteAvoided: {
          plasticBottles: Math.round(totals.plasticBottles * 100) / 100,
          packages: totals.packages
        },
        lastAccrualDate: lastDate
      };
    } else if (raw.tracker !== undefined) {
      repaired = true;
    }

    // Очередь синхронизации с Supabase
    if (raw.sync && Array.isArray(raw.sync.pending)) {
      var pendingSeen = {};
      raw.sync.pending.forEach(function (item) {
        var p = sanitizePending(item);
        if (!p || pendingSeen[p.date]) return;
        pendingSeen[p.date] = true;
        state.sync.pending.push(p);
      });
      // Сервер принимает записи не старше 7 дней — хранить больше нет смысла
      state.sync.pending = state.sync.pending.slice(-30);
    }

    return { state: state, repaired: repaired };
  }

  function backup(raw) {
    try { global.localStorage.setItem(BACKUP_KEY, String(raw).slice(0, 200000)); } catch (e) { /* ignore */ }
  }

  /**
   * Загружает состояние.
   * status: 'new' | 'restored' | 'repaired' | 'unavailable'
   */
  function load() {
    if (!isAvailable()) {
      if (!memoryCopy) memoryCopy = createDefaultState();
      return { state: JSON.parse(JSON.stringify(memoryCopy)), status: 'unavailable' };
    }

    var raw;
    try {
      raw = global.localStorage.getItem(KEY);
    } catch (e) {
      return { state: createDefaultState(), status: 'unavailable' };
    }
    if (raw === null) return { state: createDefaultState(), status: 'new' };

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      backup(raw);
      return { state: createDefaultState(), status: 'repaired' };
    }

    var result = sanitize(parsed);
    if (result.repaired) backup(raw);
    return { state: result.state, status: result.repaired ? 'repaired' : 'restored' };
  }

  function save(state) {
    if (!isAvailable()) {
      memoryCopy = JSON.parse(JSON.stringify(state));
      return false;
    }
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  PB.storage = {
    key: KEY,
    load: load,
    save: save,
    sanitize: sanitize,
    createDefaultState: createDefaultState,
    isAvailable: isAvailable,
    generateId: generateId
  };
})(window);
