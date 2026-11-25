-- =========================================================
-- PlasticBack — схема базы данных Supabase (PostgreSQL)
-- Выполните целиком в Supabase → SQL Editor → New query.
-- Скрипт идемпотентен: его можно запускать повторно.
-- =========================================================

-- 1. Таблица обезличенных записей об экономии
create table if not exists public.savings_records (
  id            bigint generated always as identity primary key,
  anon_user_id  uuid          not null,                -- анонимный ID из LocalStorage (НЕ аутентификация)
  amount_kzt    numeric(12,2) not null,                -- сумма экономии за день, ₸
  waste_items   integer       not null,                -- предотвращённые упаковки, шт.
  accrual_date  date          not null,                -- дата начисления (локальная дата устройства)
  created_at    timestamptz   not null default now(),  -- дата создания записи

  -- Границы совпадают с config.limits в js/config.js
  constraint savings_amount_range check (amount_kzt > 0 and amount_kzt <= 21700),
  constraint savings_waste_range  check (waste_items >= 0 and waste_items <= 30),

  -- Защита от дублирования: одна запись на анонимного пользователя в день
  constraint savings_one_per_day unique (anon_user_id, accrual_date)
);

create index if not exists savings_records_accrual_date_idx
  on public.savings_records (accrual_date);

comment on table public.savings_records is
  'Обезличенные записи об экономии PlasticBack. Прямой доступ клиентов закрыт RLS; запись и чтение только через RPC.';

-- 2. Row Level Security
-- RLS включён, политик для anon/authenticated НЕТ — значит, прямые
-- SELECT/INSERT/UPDATE/DELETE с клиента запрещены. Отдельные записи
-- пользователей никогда не отдаются наружу.
alter table public.savings_records enable row level security;
alter table public.savings_records force row level security;

revoke all on table public.savings_records from anon, authenticated;

-- 3. RPC: добавление записи об экономии
-- SECURITY DEFINER позволяет функции писать в таблицу в обход RLS,
-- но только после серверной валидации входных данных.
create or replace function public.record_saving(
  p_anon_id       uuid,
  p_accrual_date  date,
  p_amount        numeric,
  p_waste_items   integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_rows  integer;
begin
  if p_anon_id is null then
    raise exception 'invalid_anon_id' using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > 21700 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  if p_waste_items is null or p_waste_items < 0 or p_waste_items > 30 then
    raise exception 'invalid_waste_items' using errcode = '22023';
  end if;

  -- Допускаем часовые пояса (+1 день) и отложенную отправку офлайн-записей (−7 дней)
  if p_accrual_date is null
     or p_accrual_date > v_today + 1
     or p_accrual_date < v_today - 7 then
    raise exception 'invalid_date' using errcode = '22023';
  end if;

  insert into public.savings_records (anon_user_id, amount_kzt, waste_items, accrual_date)
  values (p_anon_id, round(p_amount, 2), p_waste_items, p_accrual_date)
  on conflict (anon_user_id, accrual_date) do nothing;

  get diagnostics v_rows = row_count;
  return case when v_rows = 1 then 'inserted' else 'duplicate' end;
end;
$$;

-- 4. RPC: агрегированная глобальная статистика (без отдельных записей)
create or replace function public.get_global_stats()
returns table (
  total_saved        numeric,
  total_waste_items  bigint,
  participants       bigint,
  marked_days        bigint,
  updated_at         timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(amount_kzt), 0)::numeric      as total_saved,
    coalesce(sum(waste_items), 0)::bigint      as total_waste_items,
    count(distinct anon_user_id)::bigint       as participants,
    count(*)::bigint                           as marked_days,
    now()                                      as updated_at
  from public.savings_records;
$$;

-- 5. Права на выполнение функций
revoke all on function public.record_saving(uuid, date, numeric, integer) from public;
revoke all on function public.get_global_stats() from public;

grant execute on function public.record_saving(uuid, date, numeric, integer) to anon, authenticated;
grant execute on function public.get_global_stats() to anon, authenticated;

-- ---------------------------------------------------------
-- Ограничения защиты (важно понимать):
-- * anon_user_id генерируется на устройстве и может быть подменён.
--   Один человек может создать много идентификаторов, поэтому
--   глобальная статистика НЕ защищена от накрутки полностью.
-- * Серверные проверки ограничивают сумму, количество упаковок,
--   диапазон дат и число записей на один ID в день.
-- * Для усиления защиты на следующих этапах: Supabase Anonymous Auth
--   или Telegram initData + rate limiting через Edge Functions.
-- ---------------------------------------------------------
