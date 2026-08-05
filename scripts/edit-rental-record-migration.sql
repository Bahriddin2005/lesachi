begin;

alter table public.rental_events
  drop constraint if exists rental_events_event_type_check;
alter table public.rental_events
  add constraint rental_events_event_type_check
  check (event_type in ('return', 'payment', 'edit'));

create or replace function public.edit_rental_record(
  p_rental_id text,
  p_items jsonb,
  p_actor text default 'Admin',
  p_changed_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payload_item jsonb;
  source_item public.rental_items%rowtype;
  equipment_row public.equipment_types%rowtype;
  type_usage record;
  open_count integer;
  unique_count integer;
  desired_quantity integer;
  other_quantity integer;
  current_quantity integer;
  available_quantity integer;
  quantity_value integer;
  daily_price_value integer;
  started_at_value timestamptz;
  before_items jsonb;
  after_items jsonb;
  changed boolean := false;
  event_id text;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Tahrirlanadigan anjom topilmadi.';
  end if;
  if not exists (select 1 from public.rentals where id = p_rental_id) then
    raise exception 'Ijara topilmadi.';
  end if;

  perform 1 from public.rental_items
  where rental_id = p_rental_id and status = 'open' and quantity > 0
  for update;
  select count(*) into open_count
  from public.rental_items
  where rental_id = p_rental_id and status = 'open' and quantity > 0;
  if open_count = 0 then
    raise exception 'Qaytarilgan tarixni tahrirlab bo‘lmaydi. Ochiq anjom yo‘q.';
  end if;
  if open_count <> jsonb_array_length(p_items) then
    raise exception 'Anjomlar ro‘yxati yangilangan. Oynani yopib, qayta oching.';
  end if;
  select count(distinct entry->>'id') into unique_count from jsonb_array_elements(p_items) entry;
  if unique_count <> open_count then
    raise exception 'Anjom qatorlari takrorlangan yoki topilmadi.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'equipmentTypeId', equipment_type_id, 'name', name,
    'quantity', quantity, 'dailyPrice', daily_price, 'startedAt', started_at
  ) order by id), '[]'::jsonb)
  into before_items
  from public.rental_items
  where rental_id = p_rental_id and status = 'open' and quantity > 0;

  for payload_item in select * from jsonb_array_elements(p_items) loop
    if nullif(trim(payload_item->>'id'), '') is null
       or nullif(trim(payload_item->>'equipmentTypeId'), '') is null then
      raise exception 'Anjom turi topilmadi.';
    end if;
    quantity_value := (payload_item->>'quantity')::integer;
    daily_price_value := (payload_item->>'dailyPrice')::integer;
    started_at_value := (payload_item->>'startedAt')::timestamptz;
    if quantity_value <= 0 then raise exception 'Anjom sonini 1 yoki undan katta kiriting.'; end if;
    if daily_price_value < 0 then raise exception 'Kunlik narxni to‘g‘ri kiriting.'; end if;
    if started_at_value > p_changed_at then raise exception 'Olingan sana kelajakda bo‘lishi mumkin emas.'; end if;

    select * into source_item from public.rental_items
    where id = payload_item->>'id' and rental_id = p_rental_id
      and status = 'open' and quantity > 0;
    if not found then
      raise exception 'Anjomlar ro‘yxati yangilangan. Oynani yopib, qayta oching.';
    end if;
    if not exists (select 1 from public.equipment_types where id = payload_item->>'equipmentTypeId') then
      raise exception 'Tanlangan anjom omborda topilmadi.';
    end if;
    if source_item.equipment_type_id is distinct from payload_item->>'equipmentTypeId'
       or source_item.quantity <> quantity_value
       or source_item.daily_price <> daily_price_value
       or source_item.started_at is distinct from started_at_value then
      changed := true;
    end if;
  end loop;
  if not changed then raise exception 'Hech qanday o‘zgarish kiritilmadi.'; end if;

  for type_usage in
    select entry->>'equipmentTypeId' as equipment_type_id,
           sum((entry->>'quantity')::integer)::integer as desired_quantity
    from jsonb_array_elements(p_items) entry
    group by entry->>'equipmentTypeId'
  loop
    select * into equipment_row from public.equipment_types
    where id = type_usage.equipment_type_id for update;
    if not found then raise exception 'Tanlangan anjom omborda topilmadi.'; end if;
    desired_quantity := type_usage.desired_quantity;
    select coalesce(sum(ri.quantity), 0)::integer into other_quantity
    from public.rental_items ri join public.rentals r on r.id = ri.rental_id
    where ri.equipment_type_id = type_usage.equipment_type_id
      and ri.rental_id <> p_rental_id and ri.status = 'open'
      and ri.quantity > 0 and r.status <> 'closed';
    select coalesce(sum(quantity), 0)::integer into current_quantity
    from public.rental_items
    where rental_id = p_rental_id and equipment_type_id = type_usage.equipment_type_id
      and status = 'open' and quantity > 0;
    available_quantity := greatest(current_quantity, equipment_row.total_quantity - other_quantity, 0);
    if desired_quantity > available_quantity then
      raise exception '%: omborda bu ijara uchun faqat % dona mavjud.', equipment_row.name, available_quantity;
    end if;
  end loop;

  for payload_item in select * from jsonb_array_elements(p_items) loop
    select * into equipment_row from public.equipment_types
    where id = payload_item->>'equipmentTypeId';
    update public.rental_items
    set equipment_type_id = equipment_row.id,
        name = equipment_row.name,
        quantity = (payload_item->>'quantity')::integer,
        daily_price = (payload_item->>'dailyPrice')::integer,
        started_at = (payload_item->>'startedAt')::timestamptz
    where id = payload_item->>'id' and rental_id = p_rental_id and status = 'open';
  end loop;

  update public.rentals
  set started_at = coalesce((select min(started_at) from public.rental_items where rental_id = p_rental_id), started_at),
      status = 'active', closed_at = null
  where id = p_rental_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'equipmentTypeId', equipment_type_id, 'name', name,
    'quantity', quantity, 'dailyPrice', daily_price, 'startedAt', started_at
  ) order by id), '[]'::jsonb)
  into after_items
  from public.rental_items
  where rental_id = p_rental_id and status = 'open' and quantity > 0;

  event_id := 'event_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
  insert into public.rental_events (
    id, rental_id, event_type, quantity, amount, details, actor, created_at
  ) values (
    event_id, p_rental_id, 'edit',
    (select coalesce(sum((entry->>'quantity')::integer), 0) from jsonb_array_elements(after_items) entry),
    0, jsonb_build_object('before', before_items, 'after', after_items),
    coalesce(nullif(trim(p_actor), ''), 'Admin'), p_changed_at
  );

  return jsonb_build_object(
    'id', event_id, 'rentalId', p_rental_id, 'type', 'edit',
    'quantity', (select coalesce(sum((entry->>'quantity')::integer), 0) from jsonb_array_elements(after_items) entry),
    'amount', 0, 'details', jsonb_build_object('before', before_items, 'after', after_items),
    'actor', coalesce(nullif(trim(p_actor), ''), 'Admin'), 'createdAt', p_changed_at,
    'items', after_items
  );
end;
$$;

grant execute on function public.edit_rental_record(text, jsonb, text, timestamptz)
  to anon, authenticated;

commit;
