-- =========================================================
-- Миграция 001: лимит дневной экономии 21 000 → 21 700 ₸
-- Причина: новые средние цены по Казахстану (кофе 1 250 ₸, энергетик 670 ₸).
-- 10 × (250 + 1 250 + 670) = 21 700 ₸.
-- Выполните в Supabase → SQL Editor, если база уже создана по старой схеме.
-- Для новой базы достаточно database/schema.sql.
-- =========================================================

alter table public.savings_records
  drop constraint if exists savings_amount_range;

alter table public.savings_records
  add constraint savings_amount_range check (amount_kzt > 0 and amount_kzt <= 21700);

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

revoke all on function public.record_saving(uuid, date, numeric, integer) from public;
grant execute on function public.record_saving(uuid, date, numeric, integer) to anon, authenticated;
