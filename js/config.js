/**
 * PlasticBack — конфигурация приложения.
 *
 * Здесь собраны все цены, коэффициенты, пороги загрязнения и материальные
 * эквиваленты. Бизнес-логика читает значения только отсюда, поэтому их можно
 * менять без правок остального кода.
 *
 * Поле `temporary: true` означает, что значение НЕ утверждено командой
 * и используется как временное до проверки.
 */
(function (global) {
  'use strict';

  var PB = (global.PlasticBack = global.PlasticBack || {});

  function deepFreeze(obj) {
    Object.keys(obj).forEach(function (key) {
      var value = obj[key];
      if (value && typeof value === 'object') deepFreeze(value);
    });
    return Object.freeze(obj);
  }

  var drinks = [
    {
      id: 'water',
      name: 'Бутилированная вода',
      shortName: 'Вода',
      unitLabel: 'бутылка 0,5 л',
      price: 250,
      defaultQuantity: 2,
      icon: 'assets/icons/drink-water.svg',
      // Номинальный объём бутылки. Это объём НАПИТКА, а не объём мусора.
      nominalBottleVolumeLiters: 0.5,
      packaging: {
        kind: 'Пластиковая PET-бутылка',
        // Сколько «пластиковых бутылок» даёт одна покупка.
        plasticBottleFactor: 1,
        temporary: false
      }
    },
    {
      id: 'coffee',
      name: 'Кофе',
      shortName: 'Кофе',
      unitLabel: 'стакан навынос',
      price: 1200,
      defaultQuantity: 1,
      icon: 'assets/icons/drink-coffee.svg',
      nominalBottleVolumeLiters: 0,
      packaging: {
        kind: 'Бумажный стакан с пластиковой крышкой',
        // 0 — стаканчик не считается пластиковой бутылкой,
        // пока коэффициент пересчёта не утверждён.
        plasticBottleFactor: 0,
        temporary: true
      }
    },
    {
      id: 'energy',
      name: 'Энергетические напитки',
      shortName: 'Энергетики',
      unitLabel: 'банка 0,45 л',
      price: 650,
      defaultQuantity: 0,
      icon: 'assets/icons/drink-energy.svg',
      nominalBottleVolumeLiters: 0,
      packaging: {
        kind: 'Алюминиевая банка',
        // 0 — банка не является пластиковой бутылкой.
        plasticBottleFactor: 0,
        temporary: true
      }
    }
  ];

  var slider = { min: 0, max: 10, step: 1 };

  // Максимально возможная сумма за день при текущих ценах и ползунках.
  var maxDailyAmount = drinks.reduce(function (sum, d) {
    return sum + d.price * slider.max;
  }, 0);

  PB.config = deepFreeze({
    app: {
      name: 'PlasticBack',
      locale: 'ru-RU',
      currency: '₸'
    },

    storage: {
      key: 'plasticback:v1',
      backupKey: 'plasticback:v1:backup',
      version: 1
    },

    drinks: drinks,
    slider: slider,

    periods: {
      daysInMonth: 30,
      daysInYear: 365
    },

    /**
     * Визуализация комнаты. Состояние выбирается по количеству
     * пластиковых бутылок за год (покупки × plasticBottleFactor × 365).
     * Чтобы заменить иллюстрации, достаточно положить новые файлы
     * и поменять пути `image` — логика не меняется.
     */
    room: {
      temporary: true,
      // Количество бутылок в год, при котором шкала заполнена на 100 %.
      fillCap: 1460,
      states: [
        {
          id: 'clean',
          title: 'Чисто',
          description: 'Пластиковые бутылки не копятся — так держать.',
          minBottles: 0,
          image: 'assets/images/room-clean.svg'
        },
        {
          id: 'cluttered',
          title: 'Захламлено',
          description: 'Бутылки уже заметны. До одной в день — и комната превращается в склад.',
          minBottles: 1,
          image: 'assets/images/room-cluttered.svg'
        },
        {
          id: 'knee',
          title: 'По колено в пластике',
          description: 'Больше бутылки в день. За год пластик покрывает весь пол.',
          minBottles: 366,
          image: 'assets/images/room-knee.svg'
        },
        {
          id: 'catastrophe',
          title: 'Катастрофа',
          description: 'Больше трёх бутылок в день. Пластик добирается до потолка.',
          minBottles: 1096,
          image: 'assets/images/room-catastrophe.svg'
        }
      ]
    },

    /** Материальные эквиваленты годовых расходов. Цены временные. */
    equivalents: [
      {
        id: 'gym',
        title: 'Абонементов в фитнес-зал',
        note: 'по 15 000 ₸ за месяц',
        price: 15000,
        icon: 'assets/icons/eq-gym.svg',
        temporary: true
      },
      {
        id: 'cinema',
        title: 'Билетов в кино',
        note: 'по 2 500 ₸',
        price: 2500,
        icon: 'assets/icons/eq-cinema.svg',
        temporary: true
      },
      {
        id: 'doner',
        title: 'Донеров',
        note: 'по 1 800 ₸',
        price: 1800,
        icon: 'assets/icons/eq-doner.svg',
        temporary: true
      }
    ],

    /** Сценарии потенциальной экономии (доля сокращённых покупок). */
    potentialSavings: {
      scenarios: [
        { id: 'half', label: 'Сократить покупки вдвое', share: 0.5 },
        { id: 'full', label: 'Перейти на многоразовую бутылку и кофе из дома', share: 1 }
      ]
    },

    tracker: {
      goalDays: 30,
      calendarDays: 14,
      maxHistoryEntries: 3660
    },

    /**
     * Supabase. Указывайте ТОЛЬКО публичный anon key.
     * service_role key никогда не размещается на клиенте.
     * Пустые значения = глобальная статистика отключена,
     * калькулятор и трекер продолжают работать локально.
     */
    supabase: {
      url: 'https://yxveuehwwtvlfktwfacd.supabase.co',
      anonKey: 'sb_publishable_qKaPZMOim1TLhhCfhm90AA_Y5rcYTdQ',
      sdkUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
      rpc: {
        recordSaving: 'record_saving',
        globalStats: 'get_global_stats'
      },
      timeoutMs: 8000,
      statsRefreshMs: 60000
    },

    /** Ограничения для валидации (продублированы в database/schema.sql). */
    limits: {
      maxDailyAmount: maxDailyAmount, // 21 000 ₸ при текущих ценах
      maxDailyWasteItems: slider.max * drinks.length // 30 упаковок
    }
  });
})(window);
