/**
 * PlasticBack — логика трекера экономии.
 * Чистые функции: принимают состояние трекера и возвращают новое.
 */
(function (global) {
  'use strict';

  var PB = global.PlasticBack;

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Локальная дата устройства в формате YYYY-MM-DD. */
  function toISODate(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function todayISO(now) {
    return toISODate(now || new Date());
  }

  function parseISODate(iso) {
    var p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function addDays(iso, delta) {
    var d = parseISODate(iso);
    d.setDate(d.getDate() + delta);
    return toISODate(d);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function createEmpty(lastAccrualDate) {
    return {
      history: [],
      totalSaved: 0,
      wasteAvoided: { plasticBottles: 0, packages: 0 },
      lastAccrualDate: lastAccrualDate || null
    };
  }

  function recalcTotals(history) {
    return history.reduce(function (acc, e) {
      acc.totalSaved += e.amount;
      acc.plasticBottles += e.plasticBottles;
      acc.packages += e.packages;
      return acc;
    }, { totalSaved: 0, plasticBottles: 0, packages: 0 });
  }

  /**
   * Можно ли отметить сегодняшний день.
   * Начисление разрешено только если сегодняшняя дата строго больше даты
   * последнего начисления — это защищает и от повторного клика,
   * и от перевода часов устройства назад.
   */
  function canMark(tracker, today) {
    var last = tracker.lastAccrualDate;
    if (last === today) return { allowed: false, reason: 'already_marked' };
    if (last && last > today) return { allowed: false, reason: 'clock_changed' };
    var exists = tracker.history.some(function (e) { return e.date === today; });
    if (exists) return { allowed: false, reason: 'already_marked' };
    return { allowed: true, reason: null };
  }

  /** Отмечает день без покупок. Экономия = дневные расходы из калькулятора. */
  function markDay(tracker, calc, today) {
    var check = canMark(tracker, today);
    if (!check.allowed) return { ok: false, reason: check.reason };
    if (!calc || calc.isEmpty) return { ok: false, reason: 'empty_calculator' };

    var entry = {
      date: today,
      amount: calc.daily,
      plasticBottles: round2(calc.plasticBottlesPerDay),
      packages: calc.packagesPerDay
    };
    var history = tracker.history.concat([entry]);
    var totals = recalcTotals(history);

    return {
      ok: true,
      entry: entry,
      tracker: {
        history: history,
        totalSaved: totals.totalSaved,
        wasteAvoided: {
          plasticBottles: round2(totals.plasticBottles),
          packages: totals.packages
        },
        lastAccrualDate: today
      }
    };
  }

  /** Серия подряд идущих отмеченных дней, заканчивающаяся сегодня или вчера. */
  function getStreak(history, today) {
    var dates = {};
    history.forEach(function (e) { dates[e.date] = true; });
    var cursor = dates[today] ? today : addDays(today, -1);
    var streak = 0;
    while (dates[cursor]) {
      streak++;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  function summarize(tracker, goalDays, today) {
    var days = tracker.history.length;
    return {
      days: days,
      totalSaved: tracker.totalSaved,
      plasticBottles: tracker.wasteAvoided.plasticBottles,
      packages: tracker.wasteAvoided.packages,
      goalDays: goalDays,
      progress: goalDays > 0 ? Math.min(1, days / goalDays) : 0,
      streak: getStreak(tracker.history, today),
      markedToday: tracker.lastAccrualDate === today
    };
  }

  /** Последние N дней для мини-календаря. */
  function recentDays(tracker, count, today) {
    var marked = {};
    tracker.history.forEach(function (e) { marked[e.date] = true; });
    var out = [];
    for (var i = count - 1; i >= 0; i--) {
      var iso = addDays(today, -i);
      out.push({
        date: iso,
        day: parseISODate(iso).getDate(),
        weekday: parseISODate(iso).getDay(),
        marked: !!marked[iso],
        isToday: iso === today
      });
    }
    return out;
  }

  /**
   * Сброс личного прогресса. Дата последнего начисления сохраняется,
   * чтобы сегодняшний день нельзя было начислить повторно после сброса.
   */
  function reset(tracker) {
    return createEmpty(tracker.lastAccrualDate);
  }

  PB.tracker = {
    todayISO: todayISO,
    toISODate: toISODate,
    addDays: addDays,
    createEmpty: createEmpty,
    recalcTotals: recalcTotals,
    canMark: canMark,
    markDay: markDay,
    summarize: summarize,
    recentDays: recentDays,
    reset: reset
  };
})(window);
