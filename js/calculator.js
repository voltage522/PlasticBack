/**
 * PlasticBack — математическая модель калькулятора.
 * Чистые функции без доступа к DOM и хранилищу.
 */
(function (global) {
  'use strict';

  var PB = global.PlasticBack;
  var cfg = PB.config;

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /** Приводит значение ползунка к целому числу в допустимом диапазоне. */
  function clampQty(value) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return cfg.slider.min;
    return Math.min(cfg.slider.max, Math.max(cfg.slider.min, n));
  }

  function normalizeQuantities(quantities) {
    var out = {};
    cfg.drinks.forEach(function (d) {
      var raw = quantities && Object.prototype.hasOwnProperty.call(quantities, d.id) ? quantities[d.id] : 0;
      out[d.id] = clampQty(raw);
    });
    return out;
  }

  /** Возвращает состояние комнаты по годовому количеству пластиковых бутылок. */
  function getRoomState(bottlesPerYear) {
    var states = cfg.room.states;
    var index = 0;
    for (var i = 0; i < states.length; i++) {
      if (bottlesPerYear >= states[i].minBottles) index = i;
    }
    return {
      index: index,
      state: states[index],
      fill: Math.min(1, Math.max(0, bottlesPerYear / cfg.room.fillCap))
    };
  }

  /**
   * Основной расчёт.
   * Дневные расходы = Σ(количество × цена)
   * Месяц = день × 30, год = день × 365
   * Упаковки за год = упаковки за день × 365
   * Объём воды = бутылки воды × 0,5 л (номинальный объём напитка, не мусора)
   */
  function calculate(quantities) {
    var q = normalizeQuantities(quantities);
    var days = cfg.periods;

    var items = cfg.drinks.map(function (d) {
      var qty = q[d.id];
      return {
        id: d.id,
        name: d.name,
        qty: qty,
        price: d.price,
        daily: qty * d.price,
        yearly: qty * d.price * days.daysInYear,
        packages: qty,
        plasticBottles: qty * d.packaging.plasticBottleFactor,
        waterBottles: d.nominalBottleVolumeLiters > 0 ? qty : 0,
        waterLiters: qty * d.nominalBottleVolumeLiters
      };
    });

    function sum(field) {
      return items.reduce(function (acc, it) { return acc + it[field]; }, 0);
    }

    var daily = sum('daily');
    var monthly = daily * days.daysInMonth;
    var yearly = daily * days.daysInYear;
    var packagesPerDay = sum('packages');
    var plasticBottlesPerDay = round2(sum('plasticBottles'));
    var plasticBottlesPerYear = Math.round(plasticBottlesPerDay * days.daysInYear);
    var waterBottlesPerYear = sum('waterBottles') * days.daysInYear;
    var waterLitersPerYear = round2(sum('waterLiters') * days.daysInYear);

    var equivalents = cfg.equivalents.map(function (e) {
      return {
        id: e.id,
        title: e.title,
        note: e.note,
        icon: e.icon,
        price: e.price,
        temporary: !!e.temporary,
        count: e.price > 0 ? Math.floor(yearly / e.price) : 0
      };
    });

    var potential = cfg.potentialSavings.scenarios.map(function (s) {
      return {
        id: s.id,
        label: s.label,
        share: s.share,
        monthly: Math.round(monthly * s.share),
        yearly: Math.round(yearly * s.share)
      };
    });

    return {
      quantities: q,
      items: items,
      daily: daily,
      monthly: monthly,
      yearly: yearly,
      packagesPerDay: packagesPerDay,
      packagesPerYear: packagesPerDay * days.daysInYear,
      plasticBottlesPerDay: plasticBottlesPerDay,
      plasticBottlesPerYear: plasticBottlesPerYear,
      waterBottlesPerYear: waterBottlesPerYear,
      waterLitersPerYear: waterLitersPerYear,
      room: getRoomState(plasticBottlesPerYear),
      equivalents: equivalents,
      potential: potential,
      isEmpty: daily === 0
    };
  }

  PB.calculator = {
    calculate: calculate,
    clampQty: clampQty,
    normalizeQuantities: normalizeQuantities,
    getRoomState: getRoomState
  };
})(window);
