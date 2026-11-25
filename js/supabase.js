/**
 * PlasticBack — взаимодействие с Supabase.
 *
 * Клиент использует только публичный anon key и вызывает две RPC-функции:
 *   record_saving     — добавить обезличенную запись об экономии;
 *   get_global_stats  — получить агрегированную статистику.
 * Прямого доступа к таблице у клиента нет (Row Level Security без политик).
 *
 * ВАЖНО: анонимный идентификатор из LocalStorage не является аутентификацией.
 * Серверная валидация ограничивает размер и частоту записей, но не делает
 * глобальную статистику полностью защищённой от накрутки.
 */
(function (global) {
  'use strict';

  var PB = global.PlasticBack;
  var cfg = PB.config.supabase;
  var limits = PB.config.limits;

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  var client = null;
  var status = 'idle'; // idle | loading | ready | not_configured | sdk_unavailable | init_error
  var initPromise = null;

  function isConfigured() {
    return typeof cfg.url === 'string' && /^https:\/\/[^\s]+$/.test(cfg.url) &&
      typeof cfg.anonKey === 'string' && cfg.anonKey.length > 20;
  }

  function loadSdk() {
    if (global.supabase && typeof global.supabase.createClient === 'function') {
      return Promise.resolve(true);
    }
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = cfg.sdkUrl;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = function () { resolve(!!(global.supabase && global.supabase.createClient)); };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
    });
  }

  /** Инициализация. SDK загружается только если Supabase настроен. */
  function init() {
    if (initPromise) return initPromise;
    if (!isConfigured()) {
      status = 'not_configured';
      initPromise = Promise.resolve(status);
      return initPromise;
    }
    status = 'loading';
    initPromise = loadSdk().then(function (ok) {
      if (!ok) {
        status = 'sdk_unavailable';
        return status;
      }
      try {
        client = global.supabase.createClient(cfg.url, cfg.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        });
        status = 'ready';
      } catch (e) {
        status = 'init_error';
      }
      return status;
    });
    return initPromise;
  }

  function isEnabled() {
    return status === 'ready' && client !== null;
  }

  function getStatus() {
    return status;
  }

  function classifyError(error) {
    var message = (error && (error.message || error.details)) || 'Unknown error';
    var code = error && error.code;
    if (code === '22023' || /invalid_/.test(message)) {
      return { kind: 'validation', permanent: true, message: message };
    }
    if (code === 'PGRST202' || code === '42883') {
      return { kind: 'schema', permanent: false, message: 'RPC-функция не найдена. Выполните database/schema.sql.' };
    }
    if (error && (error.name === 'AbortError' || /abort/i.test(message))) {
      return { kind: 'timeout', permanent: false, message: 'Превышено время ожидания ответа' };
    }
    if (/fetch|network|Failed to/i.test(message)) {
      return { kind: 'network', permanent: false, message: message };
    }
    return { kind: 'server', permanent: false, message: message };
  }

  function callRpc(fn, params) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, cfg.timeoutMs);
    var query = client.rpc(fn, params || {});
    if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);

    return Promise.resolve(query).then(function (res) {
      clearTimeout(timer);
      if (res.error) return { ok: false, error: classifyError(res.error) };
      return { ok: true, data: res.data };
    }, function (err) {
      clearTimeout(timer);
      return { ok: false, error: classifyError(err) };
    });
  }

  /** Клиентская валидация (повторяется на сервере в record_saving). */
  function validateSaving(p) {
    if (!p || typeof p !== 'object') return 'invalid_payload';
    if (typeof p.anonId !== 'string' || !UUID_RE.test(p.anonId)) return 'invalid_anon_id';
    if (typeof p.date !== 'string' || !DATE_RE.test(p.date)) return 'invalid_date';
    var amount = Number(p.amount);
    if (!isFinite(amount) || amount <= 0 || amount > limits.maxDailyAmount) return 'invalid_amount';
    var waste = Number(p.wasteItems);
    if (!isFinite(waste) || waste < 0 || waste > limits.maxDailyWasteItems || Math.round(waste) !== waste) {
      return 'invalid_waste_items';
    }
    return null;
  }

  /**
   * Добавляет запись об экономии.
   * Повтор за ту же дату для того же anonId сервер игнорирует (status 'duplicate').
   */
  function recordSaving(payload) {
    if (!isEnabled()) return Promise.resolve({ ok: false, error: { kind: 'disabled', permanent: false } });
    var invalid = validateSaving(payload);
    if (invalid) return Promise.resolve({ ok: false, error: { kind: 'validation', permanent: true, message: invalid } });

    return callRpc(cfg.rpc.recordSaving, {
      p_anon_id: payload.anonId,
      p_accrual_date: payload.date,
      p_amount: Math.round(Number(payload.amount) * 100) / 100,
      p_waste_items: payload.wasteItems
    }).then(function (res) {
      if (!res.ok) return res;
      return { ok: true, status: res.data === 'duplicate' ? 'duplicate' : 'inserted' };
    });
  }

  /** Агрегированная статистика без отдельных пользовательских записей. */
  function getGlobalStats() {
    if (!isEnabled()) return Promise.resolve({ ok: false, error: { kind: 'disabled' } });
    return callRpc(cfg.rpc.globalStats).then(function (res) {
      if (!res.ok) return res;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!row || typeof row !== 'object') {
        return { ok: false, error: { kind: 'server', message: 'Пустой ответ' } };
      }
      return {
        ok: true,
        stats: {
          totalSaved: Number(row.total_saved) || 0,
          totalWasteItems: Number(row.total_waste_items) || 0,
          participants: Number(row.participants) || 0,
          markedDays: Number(row.marked_days) || 0,
          updatedAt: row.updated_at || null
        }
      };
    });
  }

  PB.api = {
    init: init,
    isConfigured: isConfigured,
    isEnabled: isEnabled,
    getStatus: getStatus,
    validateSaving: validateSaving,
    recordSaving: recordSaving,
    getGlobalStats: getGlobalStats
  };
})(window);
