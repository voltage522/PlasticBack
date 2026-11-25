/**
 * PlasticBack — UI-контроллер.
 * Связывает интерфейс с бизнес-логикой (calculator, tracker),
 * локальным хранилищем (storage) и сервером (api).
 */
(function (global, doc) {
  'use strict';

  var PB = global.PlasticBack;
  var cfg = PB.config;
  var calculator = PB.calculator;
  var trackerLogic = PB.tracker;
  var storage = PB.storage;
  var api = PB.api;

  var SCREENS = ['calculator', 'results', 'tracker'];
  var WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = null;
  var calc = null;
  var currentScreen = null;
  var els = {};
  var drinkRefs = {};
  var saveTimer = null;
  var statsTimer = null;
  var syncing = false;
  var globalStats = null;
  var saveWarningShown = false;

  /* ---------- Форматирование ---------- */

  var fmtInt = new Intl.NumberFormat(cfg.app.locale, { maximumFractionDigits: 0 });
  var fmtDec = new Intl.NumberFormat(cfg.app.locale, { maximumFractionDigits: 1 });

  function money(n) {
    return fmtInt.format(Math.round(n)) + ' ' + cfg.app.currency;
  }
  function num(n) {
    return fmtInt.format(Math.round(n));
  }
  function dec(n) {
    return fmtDec.format(n);
  }
  var pluralRules = new Intl.PluralRules(cfg.app.locale);
  var PLURAL_INDEX = { one: 0, few: 1, many: 2, other: 1 };
  /** forms: [один, несколько, много] — «день», «дня», «дней» */
  function plural(n, forms) {
    return forms[PLURAL_INDEX[pluralRules.select(n)]];
  }

  function $(sel, root) {
    return (root || doc).querySelector(sel);
  }

  /* ---------- Анимации ---------- */

  function countUp(el, to, format, opts) {
    opts = opts || {};
    var from = opts.from !== undefined ? opts.from : Number(el.dataset.value || 0);
    el.dataset.value = String(to);
    if (el._raf) cancelAnimationFrame(el._raf);
    if (reducedMotion || from === to) {
      el.textContent = format(to);
      return;
    }
    var duration = opts.duration || 900;
    var start = performance.now();
    function frame(t) {
      var p = Math.min(1, (t - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(from + (to - from) * eased);
      if (p < 1) el._raf = requestAnimationFrame(frame);
      else el.textContent = format(to);
    }
    el._raf = requestAnimationFrame(frame);
  }

  function retrigger(el, className) {
    el.classList.remove(className);
    void el.offsetWidth; // перезапуск CSS-анимации
    el.classList.add(className);
  }

  /* ---------- Уведомления ---------- */

  var toastTimer = null;
  function toast(message, type) {
    var el = els.toast;
    els.toastText.textContent = message;
    el.dataset.type = type || 'info';
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 3200);
  }

  /* ---------- Сохранение ---------- */

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = null;
    var ok = storage.save(state);
    if (!ok && !saveWarningShown) {
      saveWarningShown = true;
      toast('Не удалось сохранить данные на устройстве. Прогресс сохранится только до закрытия вкладки.', 'error');
    }
  }

  function schedulePersist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 200);
  }

  /* ---------- Калькулятор ---------- */

  function renderDrinks() {
    var tpl = $('#tpl-drink');
    cfg.drinks.forEach(function (d) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      var rangeId = 'range-' + d.id;
      node.dataset.drink = d.id;

      var img = $('.drink__icon img', node);
      img.src = d.icon;
      $('.drink__name', node).textContent = d.name;
      $('.drink__price', node).textContent = money(d.price) + ' · ' + d.unitLabel;

      var range = $('.range', node);
      range.id = rangeId;
      range.min = cfg.slider.min;
      range.max = cfg.slider.max;
      range.step = cfg.slider.step;
      range.dataset.drink = d.id;
      range.setAttribute('aria-label', d.name + ': покупок в день');

      var output = $('.drink__qty-value', node);
      output.setAttribute('for', rangeId);

      var buttons = node.querySelectorAll('.step-btn');
      buttons[0].dataset.drink = d.id;
      buttons[1].dataset.drink = d.id;
      buttons[0].setAttribute('aria-label', 'Уменьшить: ' + d.name);
      buttons[1].setAttribute('aria-label', 'Увеличить: ' + d.name);

      els.drinkList.appendChild(node);
      drinkRefs[d.id] = {
        card: node,
        range: range,
        qty: output,
        qtyLabel: $('.drink__qty-label', node),
        daily: $('.drink__daily', node),
        yearly: $('.drink__yearly', node),
        minus: buttons[0],
        plus: buttons[1]
      };
    });

    els.drinkList.addEventListener('input', function (e) {
      var t = e.target;
      if (t.classList.contains('range')) setQuantity(t.dataset.drink, t.value);
    });
    els.drinkList.addEventListener('click', function (e) {
      var btn = e.target.closest('.step-btn');
      if (!btn || btn.disabled) return;
      var id = btn.dataset.drink;
      setQuantity(id, state.calculator.quantities[id] + Number(btn.dataset.step));
    });
  }

  function setQuantity(id, value) {
    var next = calculator.clampQty(value);
    var prev = state.calculator.quantities[id];
    if (next === prev) {
      drinkRefs[id].range.value = next;
      return;
    }
    state.calculator.quantities[id] = next;
    state.calculator.settings.updatedAt = new Date().toISOString();
    recalc();
    schedulePersist();
  }

  function recalc() {
    calc = calculator.calculate(state.calculator.quantities);
    updateCalculatorUI();
  }

  function updateCalculatorUI() {
    var span = cfg.slider.max - cfg.slider.min;
    calc.items.forEach(function (it) {
      var r = drinkRefs[it.id];
      var pct = span > 0 ? ((it.qty - cfg.slider.min) / span) * 100 : 0;
      r.range.value = it.qty;
      r.range.style.setProperty('--fill', pct + '%');
      r.range.setAttribute('aria-valuetext', it.qty + ' ' + plural(it.qty, ['покупка', 'покупки', 'покупок']) + ' в день');
      r.qty.textContent = it.qty;
      r.qtyLabel.textContent = plural(it.qty, ['покупка', 'покупки', 'покупок']);
      r.daily.textContent = money(it.daily);
      r.yearly.textContent = money(it.yearly);
      r.minus.disabled = it.qty <= cfg.slider.min;
      r.plus.disabled = it.qty >= cfg.slider.max;
      r.card.classList.toggle('is-active', it.qty > 0);
    });

    els.sumDaily.textContent = money(calc.daily);
    els.sumMonthly.textContent = money(calc.monthly);
    els.sumYearly.textContent = money(calc.yearly);
    if (calc.isEmpty) {
      els.sumHint.textContent = 'Передвинь ползунки — расчёт обновится мгновенно.';
    } else {
      els.sumHint.textContent = num(calc.packagesPerDay) + ' ' +
        plural(calc.packagesPerDay, ['упаковка', 'упаковки', 'упаковок']) +
        ' в день · ' + money(calc.monthly) + ' в месяц';
    }
  }

  /* ---------- Результаты ---------- */

  function renderResults() {
    var empty = calc.isEmpty;
    els.resultsEmpty.hidden = !empty;
    els.resultsContent.hidden = empty;
    if (empty) return;

    els.resYearly.style.setProperty('--chars', String(money(calc.yearly).length));

    // Эффект «Wrapped»: числа каждый раз считаются с нуля
    countUp(els.resYearly, calc.yearly, money, { from: 0, duration: 1400 });
    countUp(els.resDaily, calc.daily, money, { from: 0 });
    countUp(els.resMonthly, calc.monthly, money, { from: 0 });
    countUp(els.resPackages, calc.packagesPerYear, num, { from: 0 });
    countUp(els.resLiters, calc.waterLitersPerYear, function (v) { return dec(v) + ' л'; }, { from: 0 });

    els.resLitersNote.textContent = calc.waterBottlesPerYear > 0
      ? num(calc.waterBottlesPerYear) + ' ' + plural(calc.waterBottlesPerYear, ['бутылка', 'бутылки', 'бутылок']) + ' × 0,5 л — объём напитка, а не мусора'
      : 'Ты не покупаешь бутилированную воду';

    els.resYearlySub.innerHTML = 'Это <b>' + money(calc.monthly) + '</b> каждый месяц и <b>' +
      num(calc.packagesPerYear) + '</b> ' + plural(calc.packagesPerYear, ['упаковка', 'упаковки', 'упаковок']) + ' в мусорке.';

    renderSplit();
    renderRoom(calc.room);
    renderEquivalents();
    renderPotential();

    retrigger(els.resultsContent, 'is-revealing');
  }

  /** Доля каждого напитка в годовых расходах. */
  function renderSplit() {
    var items = calc.items.filter(function (it) { return it.yearly > 0; });
    els.resSplitBar.innerHTML = '';
    els.resSplitLegend.innerHTML = '';
    items.forEach(function (it) {
      var share = calc.yearly > 0 ? it.yearly / calc.yearly : 0;
      var seg = doc.createElement('span');
      seg.className = 'split__seg';
      seg.dataset.drink = it.id;
      seg.style.flexGrow = String(share);
      seg.style.background = 'var(--swatch)';
      els.resSplitBar.appendChild(seg);

      var li = doc.createElement('li');
      li.dataset.drink = it.id;
      li.innerHTML = '<i style="background: var(--swatch)"></i><span></span><span><b>' + money(it.yearly) +
        '</b><small>' + Math.round(share * 100) + '%</small></span>';
      li.children[1].textContent = it.name;
      els.resSplitLegend.appendChild(li);
    });
  }

  function renderRoom(room) {
    var st = room.state;
    var bottles = calc.plasticBottlesPerYear;
    els.roomTitle.textContent = st.title;
    els.roomDesc.textContent = st.description;
    els.roomBadge.dataset.level = String(room.index);
    els.roomBadge.textContent = num(bottles) + ' ' + plural(bottles, ['бутылка', 'бутылки', 'бутылок']) + ' в год';

    // Иллюстрация подменяется путём из config.room.states[].image
    if (els.roomImg.dataset.src !== st.image) {
      els.roomImg.dataset.src = st.image;
      els.roomImg.classList.add('is-loading');
      els.roomFallback.hidden = true;
      els.roomImg.hidden = false;
      els.roomImg.src = st.image;
    }
    els.roomImg.alt = 'Комната: ' + st.title;
    els.roomFallbackText.textContent = st.title;

    var pct = Math.round(room.fill * 100);
    els.roomMeterFill.style.transform = 'scaleX(0)';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { els.roomMeterFill.style.transform = 'scaleX(' + room.fill + ')'; });
    });
    els.roomMeter.setAttribute('aria-valuenow', String(pct));
    els.roomMeter.setAttribute('aria-valuetext', st.title + ', ' + pct + '%');

    Array.prototype.forEach.call(els.roomSteps.children, function (li, i) {
      li.classList.toggle('is-passed', i < room.index);
      li.classList.toggle('is-current', i === room.index);
    });
  }

  function buildRoomSteps() {
    cfg.room.states.forEach(function (s) {
      var li = doc.createElement('li');
      li.textContent = s.title;
      els.roomSteps.appendChild(li);
    });
    els.roomImg.addEventListener('load', function () {
      els.roomImg.classList.remove('is-loading');
    });
    els.roomImg.addEventListener('error', function () {
      // Если иллюстрация недоступна — показываем CSS-заглушку
      els.roomImg.hidden = true;
      els.roomFallback.hidden = false;
      els.roomFallback.dataset.level = String(calc.room.index);
    });
  }

  function renderEquivalents() {
    els.eqList.innerHTML = '';
    calc.equivalents.forEach(function (eq) {
      var li = doc.createElement('li');
      li.className = 'eq';
      li.innerHTML =
        '<strong class="eq__count">' + num(eq.count) + '</strong>' +
        '<span class="eq__title"><img src="' + eq.icon + '" alt=""><span></span></span>' +
        '<span class="eq__note"></span>';
      $('.eq__title span', li).textContent = eq.title;
      $('.eq__note', li).textContent = eq.note;
      els.eqList.appendChild(li);
    });
  }

  function renderPotential() {
    els.potentialList.innerHTML = '';
    calc.potential.forEach(function (p) {
      var li = doc.createElement('li');
      li.className = 'potential__item';
      li.innerHTML =
        '<span class="potential__label"></span>' +
        '<span class="potential__values"><strong>' + money(p.yearly) + '</strong><small>в год · ' + money(p.monthly) + ' в месяц</small></span>';
      $('.potential__label', li).textContent = p.label;
      els.potentialList.appendChild(li);
    });
  }

  /* ---------- Трекер ---------- */

  function renderTracker(opts) {
    opts = opts || {};
    var today = trackerLogic.todayISO();
    var goal = cfg.tracker.goalDays;
    var s = trackerLogic.summarize(state.tracker, goal, today);

    countUp(els.trSaved, s.totalSaved, money, opts.animateFrom !== undefined ? { from: opts.animateFrom } : {});
    els.trSavedSub.textContent = s.days === 0
      ? 'Отметь первый день без покупок'
      : 'за ' + s.days + ' ' + plural(s.days, ['день', 'дня', 'дней']) + ' без напитков навынос';

    var pct = Math.round(s.progress * 100);
    els.trProgressBar.style.transform = 'scaleX(' + s.progress + ')';
    els.trProgress.setAttribute('aria-valuenow', String(pct));
    els.trProgressLabel.textContent = Math.min(s.days, goal) + ' из ' + goal + ' ' + plural(goal, ['дня', 'дней', 'дней']) +
      (s.days >= goal ? ' — цель достигнута!' : '');
    els.trProgressPct.textContent = pct + '%';

    els.trDays.textContent = num(s.days);
    els.trStreak.textContent = s.streak + ' ' + plural(s.streak, ['день', 'дня', 'дней']);
    els.trBottles.textContent = dec(s.plasticBottles);
    els.trPackages.textContent = num(s.packages);

    var dateLabel = new Date().toLocaleDateString(cfg.app.locale, { weekday: 'long', day: 'numeric', month: 'long' });
    els.trTodayLabel.textContent = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);

    var check = trackerLogic.canMark(state.tracker, today);
    var btn = els.btnMark;
    btn.classList.toggle('is-done', !check.allowed && check.reason === 'already_marked');
    if (!check.allowed) {
      btn.disabled = true;
      if (check.reason === 'already_marked') {
        els.btnMarkLabel.textContent = 'Сегодня уже отмечено';
        els.trMarkText.textContent = 'Отличная работа! Экономия за сегодня уже начислена.';
        els.trMarkHint.textContent = 'Следующую отметку можно поставить завтра.';
      } else {
        els.btnMarkLabel.textContent = 'Отметка недоступна';
        els.trMarkText.textContent = 'Дата на устройстве раньше последней отметки.';
        els.trMarkHint.textContent = 'Проверь дату и время на устройстве.';
      }
    } else if (calc.isEmpty) {
      btn.disabled = true;
      els.btnMarkLabel.textContent = 'Отметить день без покупок';
      els.trMarkText.textContent = 'Сначала укажи свои привычки в калькуляторе — так мы поймём, сколько ты экономишь за день.';
      els.trMarkHint.innerHTML = '<a href="#calculator">Открыть калькулятор</a>';
    } else {
      btn.disabled = false;
      els.btnMarkLabel.textContent = 'Отметить день без покупок';
      els.trMarkText.textContent = 'Не купил сегодня воду в бутылке, кофе или энергетик навынос? Отметь день.';
      els.trMarkHint.textContent = 'Начислим ' + money(calc.daily) + ' и ' + num(calc.packagesPerDay) + ' ' +
        plural(calc.packagesPerDay, ['упаковку', 'упаковки', 'упаковок']) + '. Один раз в день.';
    }

    renderDaysGrid(today);
    renderSyncNote();
  }

  function renderDaysGrid(today) {
    var days = trackerLogic.recentDays(state.tracker, cfg.tracker.calendarDays, today);
    els.trDaysGrid.innerHTML = '';
    days.forEach(function (d) {
      var cell = doc.createElement('div');
      cell.className = 'day' + (d.marked ? ' is-marked' : '') + (d.isToday ? ' is-today' : '');
      cell.setAttribute('role', 'listitem');
      cell.setAttribute('aria-label', d.date + (d.marked ? ' — отмечен' : ' — не отмечен'));
      cell.innerHTML = '<span class="day__wd">' + WEEKDAYS[d.weekday] + '</span><span class="day__num">' + d.day + '</span>';
      els.trDaysGrid.appendChild(cell);
    });
  }

  function renderSyncNote() {
    var pending = state.sync.pending.length;
    if (pending > 0 && api.isEnabled()) {
      els.syncNote.hidden = false;
      els.syncNote.textContent = 'Ожидают отправки в глобальную статистику: ' + pending + '. Отправим автоматически при подключении.';
    } else {
      els.syncNote.hidden = true;
    }
  }

  /** Подтягивает свежие данные из LocalStorage (защита от второй вкладки). */
  function refreshFromStorage() {
    var fresh = storage.load();
    if (fresh.status === 'restored' || fresh.status === 'repaired') {
      if (fresh.state.userId === state.userId) {
        state.tracker = fresh.state.tracker;
        state.sync = fresh.state.sync;
      }
    }
  }

  function onMarkDay() {
    refreshFromStorage();
    var today = trackerLogic.todayISO();
    var before = state.tracker.totalSaved;
    var res = trackerLogic.markDay(state.tracker, calc, today);

    if (!res.ok) {
      var messages = {
        already_marked: 'Сегодняшний день уже отмечен',
        clock_changed: 'Дата на устройстве раньше последней отметки',
        empty_calculator: 'Сначала укажи привычки в калькуляторе'
      };
      toast(messages[res.reason] || 'Не удалось отметить день', 'error');
      renderTracker();
      return;
    }

    state.tracker = res.tracker;
    state.sync.pending.push({ date: res.entry.date, amount: res.entry.amount, wasteItems: res.entry.packages });
    persist();

    renderTracker({ animateFrom: before });
    retrigger(els.savedCard, 'is-celebrating');
    toast('+' + money(res.entry.amount) + ' — день без покупок засчитан!', 'success');

    flushSync().then(function () { refreshGlobalStats(); });
  }

  /* ---------- Сброс ---------- */

  function openResetModal() {
    if (typeof els.resetModal.showModal === 'function') {
      els.resetModal.showModal();
    } else if (global.confirm('Сбросить личный прогресс? Действие нельзя отменить.')) {
      doReset();
    }
  }

  function doReset() {
    refreshFromStorage();
    state.tracker = trackerLogic.reset(state.tracker);
    persist();
    renderTracker({ animateFrom: 0 });
    toast('Личный прогресс сброшен', 'info');
  }

  /* ---------- Синхронизация с Supabase ---------- */

  function flushSync() {
    if (syncing || !api.isEnabled() || state.sync.pending.length === 0) return Promise.resolve();
    syncing = true;
    var queue = state.sync.pending.slice();

    function next(i) {
      if (i >= queue.length) return Promise.resolve();
      var item = queue[i];
      return api.recordSaving({
        anonId: state.userId,
        date: item.date,
        amount: item.amount,
        wasteItems: item.wasteItems
      }).then(function (res) {
        // Успех, дубликат или невалидная запись — убираем из очереди
        if (res.ok || (res.error && res.error.permanent)) {
          state.sync.pending = state.sync.pending.filter(function (p) { return p.date !== item.date; });
          return next(i + 1);
        }
        // Сетевая/серверная ошибка — повторим позже
        return Promise.resolve();
      });
    }

    return next(0).then(function () {
      syncing = false;
      persist();
      if (currentScreen === 'tracker') renderSyncNote();
    }, function () {
      syncing = false;
    });
  }

  /* ---------- Глобальная статистика ---------- */

  function renderGlobal(view) {
    var body = els.globalBody;
    if (view.type === 'stats') {
      var st = view.stats;
      body.innerHTML =
        '<div class="global__grid">' +
          '<div><strong class="global__value">' + money(st.totalSaved) + '</strong><span>сэкономлено вместе</span></div>' +
          '<div><strong class="global__value">' + num(st.totalWasteItems) + '</strong><span>' + plural(st.totalWasteItems, ['упаковка не выброшена', 'упаковки не выброшены', 'упаковок не выброшено']) + '</span></div>' +
          '<div><strong class="global__value">' + num(st.participants) + '</strong><span>' + plural(st.participants, ['участник', 'участника', 'участников']) + '</span></div>' +
        '</div>' +
        '<p class="note">Анонимные данные с устройств пользователей. Статистика не проходит аудит и не защищена от накрутки полностью.</p>';
      return;
    }

    var messages = {
      loading: 'Загружаем статистику…',
      not_configured: 'Глобальная статистика появится после подключения базы данных. Личный калькулятор и трекер уже работают.',
      unavailable: 'Сервер статистики сейчас недоступен. Личный прогресс сохраняется на устройстве — отправим данные позже.',
      error: 'Не удалось загрузить глобальную статистику.'
    };
    body.innerHTML = '<p class="global__status" data-type="' + view.type + '"></p>';
    $('.global__status', body).textContent = messages[view.type] || messages.error;
    if (view.type === 'error' || view.type === 'unavailable') {
      var retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn--ghost btn--sm';
      retry.textContent = 'Повторить';
      retry.addEventListener('click', function () {
        flushSync().then(refreshGlobalStats);
      });
      body.appendChild(retry);
    }
  }

  function refreshGlobalStats() {
    var status = api.getStatus();
    if (status === 'not_configured') {
      renderGlobal({ type: 'not_configured' });
      return Promise.resolve();
    }
    if (status === 'sdk_unavailable' || status === 'init_error') {
      renderGlobal({ type: 'unavailable' });
      return Promise.resolve();
    }
    if (!api.isEnabled()) {
      renderGlobal({ type: 'loading' });
      return Promise.resolve();
    }
    if (!globalStats) renderGlobal({ type: 'loading' });
    return api.getGlobalStats().then(function (res) {
      if (res.ok) {
        globalStats = res.stats;
        renderGlobal({ type: 'stats', stats: res.stats });
      } else if (globalStats) {
        // Показываем последние реальные данные, но не выдумываем новые
        renderGlobal({ type: 'stats', stats: globalStats });
      } else {
        renderGlobal({ type: res.error && (res.error.kind === 'network' || res.error.kind === 'timeout') ? 'unavailable' : 'error' });
      }
    });
  }

  function startStatsPolling() {
    stopStatsPolling();
    statsTimer = setInterval(function () {
      if (!doc.hidden) refreshGlobalStats();
    }, cfg.supabase.statsRefreshMs);
  }

  function stopStatsPolling() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  /* ---------- Навигация ---------- */

  function screenFromHash() {
    var name = (global.location.hash || '').replace('#', '');
    return SCREENS.indexOf(name) !== -1 ? name : 'calculator';
  }

  function show(screen, opts) {
    opts = opts || {};
    if (screen === currentScreen && !opts.force) return;
    var prev = currentScreen;
    currentScreen = screen;

    SCREENS.forEach(function (name) {
      var el = els.screens[name];
      el.hidden = name !== screen;
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-nav]'), function (a) {
      if (a.dataset.nav === screen) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (screen === 'results') {
      if (!state.calculator.settings.hasCalculated) {
        state.calculator.settings.hasCalculated = true;
        persist();
      }
      renderResults();
    }
    if (screen === 'tracker') {
      renderTracker();
      refreshGlobalStats();
      startStatsPolling();
    } else {
      stopStatsPolling();
    }

    if (prev !== null) {
      global.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      var headings = els.screens[screen].querySelectorAll('[tabindex="-1"]');
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].offsetParent !== null) {
          headings[i].focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  function navigate(screen) {
    if (global.location.hash === '#' + screen) show(screen);
    else global.location.hash = screen;
  }

  /* ---------- Инициализация ---------- */

  function cacheElements() {
    els.screens = {};
    SCREENS.forEach(function (name) { els.screens[name] = $('[data-screen="' + name + '"]'); });
    [
      ['drinkList', '#drink-list'], ['sumDaily', '#sum-daily'], ['sumMonthly', '#sum-monthly'],
      ['sumYearly', '#sum-yearly'], ['resSplitBar', '#res-split-bar'], ['resSplitLegend', '#res-split-legend'],
      ['toastText', '#toast-text'],
      ['sumHint', '#sum-hint'], ['btnCalculate', '#btn-calculate'],
      ['resultsEmpty', '#results-empty'], ['resultsContent', '#results-content'],
      ['resYearly', '#res-yearly'], ['resYearlySub', '#res-yearly-sub'], ['resDaily', '#res-daily'],
      ['resMonthly', '#res-monthly'], ['resPackages', '#res-packages'], ['resLiters', '#res-liters'],
      ['resLitersNote', '#res-liters-note'],
      ['roomTitle', '#room-title'], ['roomBadge', '#room-badge'], ['roomImg', '#room-img'],
      ['roomFallback', '#room-fallback'], ['roomFallbackText', '#room-fallback-text'],
      ['roomMeter', '#room-meter'], ['roomMeterFill', '#room-meter-fill'], ['roomSteps', '#room-steps'],
      ['roomDesc', '#room-desc'], ['eqList', '#eq-list'], ['potentialList', '#potential-list'],
      ['savedCard', '#saved-card'], ['trSaved', '#tr-saved'], ['trSavedSub', '#tr-saved-sub'],
      ['trProgress', '#tr-progress'], ['trProgressBar', '#tr-progress-bar'],
      ['trProgressLabel', '#tr-progress-label'], ['trProgressPct', '#tr-progress-pct'],
      ['trDays', '#tr-days'], ['trStreak', '#tr-streak'], ['trBottles', '#tr-bottles'],
      ['trPackages', '#tr-packages'], ['trTodayLabel', '#tr-today-label'], ['trMarkText', '#tr-mark-text'],
      ['trMarkHint', '#tr-mark-hint'], ['trDaysGrid', '#tr-days-grid'], ['btnMark', '#btn-mark'],
      ['btnMarkLabel', '#btn-mark-label'], ['globalBody', '#global-body'], ['syncNote', '#sync-note'],
      ['btnReset', '#btn-reset'], ['resetModal', '#reset-modal'], ['toast', '#toast']
    ].forEach(function (pair) { els[pair[0]] = $(pair[1]); });
  }

  function bindEvents() {
    els.btnCalculate.addEventListener('click', function () { navigate('results'); });
    els.btnMark.addEventListener('click', onMarkDay);
    els.btnReset.addEventListener('click', openResetModal);
    els.resetModal.addEventListener('close', function () {
      if (els.resetModal.returnValue === 'confirm') doReset();
      els.resetModal.returnValue = '';
    });
    els.resetModal.addEventListener('click', function (e) {
      if (e.target === els.resetModal) els.resetModal.close('cancel'); // клик по фону
    });

    global.addEventListener('hashchange', function () { show(screenFromHash()); });
    global.addEventListener('online', function () { flushSync().then(refreshGlobalStats); });
    global.addEventListener('pagehide', persist);

    // Синхронизация между вкладками
    global.addEventListener('storage', function (e) {
      if (e.key !== storage.key) return;
      var fresh = storage.load();
      if (fresh.status !== 'restored' && fresh.status !== 'repaired') return;
      state = fresh.state;
      recalc();
      if (currentScreen === 'tracker') renderTracker();
      if (currentScreen === 'results') renderResults();
    });

    // Смена дня, пока вкладка открыта
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden && currentScreen === 'tracker') {
        renderTracker();
        flushSync().then(refreshGlobalStats);
      }
    });
  }

  function init() {
    cacheElements();

    var loaded = storage.load();
    state = loaded.state;

    renderDrinks();
    buildRoomSteps();
    recalc();
    bindEvents();
    show(screenFromHash());
    persist();

    if (loaded.status === 'repaired') {
      toast('Часть сохранённых данных была повреждена — мы восстановили всё, что смогли.', 'error');
    } else if (loaded.status === 'unavailable') {
      toast('Хранилище браузера недоступно — данные не сохранятся после перезагрузки.', 'error');
    }

    api.init().then(function () {
      flushSync().then(function () {
        if (currentScreen === 'tracker') refreshGlobalStats();
      });
    });

    doc.documentElement.classList.add('is-ready');
  }

  // Экспорт для отладки и будущих интеграций (например, Telegram Web App)
  PB.app = {
    navigate: navigate,
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    getCalculation: function () { return calc; }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
