begin;

alter table public.rental_items
  add column if not exists paid_amount integer not null default 0;

update public.rental_items
set paid_amount = coalesce(frozen_amount, 0)
where paid = true and paid_amount = 0;

create table if not exists public.rental_events (
  id text primary key,
  rental_id text not null references public.rentals(id) on delete cascade,
  event_type text not null check (event_type in ('return', 'payment', 'edit')),
  quantity integer not null default 0,
  amount integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  actor text not null default 'Admin',
  created_at timestamptz not null default now()
);

create index if not exists rental_events_rental_created_idx
  on public.rental_events (rental_id, created_at desc);

grant select, insert, update, delete on table public.rental_events to anon, authenticated;
alter table public.rental_events enable row level security;
drop policy if exists lesachi_public_all on public.rental_events;
create policy lesachi_public_all on public.rental_events
  for all to anon, authenticated using (true) with check (true);

create or replace function public.record_rental_payment(
  p_rental_id text,
  p_amount integer,
  p_paid_at timestamptz default now(),
  p_actor text default 'Admin'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row record;
  pending_total integer;
  remaining_payment integer;
  item_pending integer;
  allocated integer;
  next_paid integer;
  allocations jsonb := '[]'::jsonb;
  event_id text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'To‘lov summasini to‘g‘ri kiriting.';
  end if;
  if not exists (select 1 from public.rentals where id = p_rental_id) then
    raise exception 'Ijara topilmadi.';
  end if;

  perform 1 from public.rental_items
  where rental_id = p_rental_id and status = 'returned'
  for update;

  select coalesce(sum(greatest(coalesce(frozen_amount, 0) - coalesce(paid_amount, 0), 0)), 0)::integer
  into pending_total
  from public.rental_items
  where rental_id = p_rental_id and status = 'returned';

  if pending_total <= 0 then
    raise exception 'Tasdiqlanmagan to‘lov yo‘q.';
  end if;
  if p_amount > pending_total then
    raise exception 'To‘lov kutilayotgan % so‘mdan oshmasligi kerak.', pending_total;
  end if;

  remaining_payment := p_amount;
  for item_row in
    select id, name, coalesce(frozen_amount, 0) as frozen_amount,
           coalesce(paid_amount, 0) as paid_amount
    from public.rental_items
    where rental_id = p_rental_id and status = 'returned'
    order by returned_at, id
  loop
    exit when remaining_payment <= 0;
    item_pending := greatest(item_row.frozen_amount - item_row.paid_amount, 0);
    if item_pending <= 0 then continue; end if;
    allocated := least(item_pending, remaining_payment);
    next_paid := item_row.paid_amount + allocated;
    update public.rental_items
    set paid_amount = next_paid,
        paid = next_paid >= item_row.frozen_amount
    where id = item_row.id;
    allocations := allocations || jsonb_build_array(jsonb_build_object(
      'itemId', item_row.id,
      'name', item_row.name,
      'amount', allocated
    ));
    remaining_payment := remaining_payment - allocated;
  end loop;

  event_id := 'event_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
  insert into public.rental_events (
    id, rental_id, event_type, quantity, amount, details, actor, created_at
  ) values (
    event_id, p_rental_id, 'payment', 0, p_amount,
    jsonb_build_object('allocations', allocations),
    coalesce(nullif(trim(p_actor), ''), 'Admin'), p_paid_at
  );

  return jsonb_build_object(
    'id', event_id,
    'rentalId', p_rental_id,
    'type', 'payment',
    'amount', p_amount,
    'actor', coalesce(nullif(trim(p_actor), ''), 'Admin'),
    'createdAt', p_paid_at,
    'remainingAmount', pending_total - p_amount,
    'details', jsonb_build_object('allocations', allocations)
  );
end;
$$;

grant execute on function public.record_rental_payment(text, integer, timestamptz, text)
  to anon, authenticated;

create or replace function public.mark_rental_item_paid(p_item_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row record;
  remaining_amount integer;
  paid_at timestamptz := now();
begin
  select id, rental_id, name, status, coalesce(frozen_amount, 0) as frozen_amount,
         coalesce(paid_amount, 0) as paid_amount
  into item_row
  from public.rental_items
  where id = p_item_id
  for update;
  if not found or item_row.status <> 'returned' then
    raise exception 'Faqat qaytarilgan anjom uchun to‘lovni tasdiqlash mumkin.';
  end if;
  remaining_amount := greatest(item_row.frozen_amount - item_row.paid_amount, 0);
  if remaining_amount = 0 then return true; end if;

  update public.rental_items
  set paid_amount = item_row.frozen_amount, paid = true
  where id = p_item_id;

  insert into public.rental_events (
    id, rental_id, event_type, quantity, amount, details, actor, created_at
  ) values (
    'event_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
    item_row.rental_id, 'payment', 0, remaining_amount,
    jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object(
      'itemId', item_row.id, 'name', item_row.name, 'amount', remaining_amount
    ))),
    'Admin', paid_at
  );
  return true;
end;
$$;

create or replace function public.register_rental_return(
  p_rental_id text,
  p_requests jsonb,
  p_returned_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  request jsonb;
  source_item public.rental_items%rowtype;
  item_id text;
  requested_quantity integer;
  remaining_quantity integer;
  started_at_value timestamptz;
  frozen_amount_value integer;
  returned_rows jsonb := '[]'::jsonb;
  remaining_rows jsonb := '[]'::jsonb;
  is_closed boolean;
  generated_item_id text;
  event_id text;
  returned_quantity_total integer;
  returned_amount_total integer;
begin
  if jsonb_typeof(p_requests) <> 'array' or jsonb_array_length(p_requests) = 0 then
    raise exception 'Qaytariladigan anjom tanlanmagan.';
  end if;
  if not exists (select 1 from public.rentals where id = p_rental_id) then
    raise exception 'Ijara topilmadi.';
  end if;

  for request in select * from jsonb_array_elements(p_requests) loop
    item_id := nullif(trim(request->>'itemId'), '');
    requested_quantity := (request->>'quantity')::integer;
    if item_id is null or requested_quantity is null or requested_quantity <= 0 then
      raise exception 'Qaytarilgan sonini to‘g‘ri kiriting.';
    end if;

    select * into source_item
    from public.rental_items
    where id = item_id and rental_id = p_rental_id
    for update;
    if not found or source_item.status <> 'open' or source_item.quantity <= 0 then
      raise exception 'Anjom allaqachon qaytarilgan yoki topilmadi.';
    end if;
    if requested_quantity > source_item.quantity then
      raise exception '%: mijozdagi % donadan ko‘p qaytarib bo‘lmaydi.', source_item.name, source_item.quantity;
    end if;

    started_at_value := source_item.started_at;
    frozen_amount_value := greatest(1,
      ((p_returned_at at time zone 'Asia/Samarkand')::date
        - (started_at_value at time zone 'Asia/Samarkand')::date)
    )
      * source_item.daily_price * requested_quantity;
    remaining_quantity := source_item.quantity - requested_quantity;

    update public.rental_items
    set quantity = requested_quantity,
        status = 'returned',
        returned_at = p_returned_at,
        frozen_amount = frozen_amount_value,
        paid_amount = 0,
        paid = false
    where id = source_item.id;

    insert into public.item_returns (id, rental_item_id, quantity, returned_at)
    values (
      'return_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
      source_item.id, requested_quantity, p_returned_at
    );

    returned_rows := returned_rows || jsonb_build_array(jsonb_build_object(
      'id', source_item.id,
      'rentalId', source_item.rental_id,
      'equipmentTypeId', source_item.equipment_type_id,
      'name', source_item.name,
      'quantity', requested_quantity,
      'dailyPrice', source_item.daily_price,
      'startedAt', started_at_value,
      'status', 'returned',
      'returnedAt', p_returned_at,
      'frozenAmount', frozen_amount_value,
      'paidAmount', 0,
      'paid', false
    ));

    if remaining_quantity > 0 then
      generated_item_id := 'item_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
      insert into public.rental_items (
        id, rental_id, equipment_type_id, name, quantity, daily_price,
        started_at, status, returned_at, frozen_amount, paid_amount, paid
      ) values (
        generated_item_id, source_item.rental_id, source_item.equipment_type_id,
        source_item.name, remaining_quantity, source_item.daily_price,
        started_at_value, 'open', null, null, 0, false
      );
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ri.id,
    'rentalId', ri.rental_id,
    'equipmentTypeId', ri.equipment_type_id,
    'name', ri.name,
    'quantity', ri.quantity,
    'dailyPrice', ri.daily_price,
    'startedAt', ri.started_at,
    'status', ri.status,
    'returnedAt', ri.returned_at,
    'frozenAmount', ri.frozen_amount,
    'paidAmount', ri.paid_amount,
    'paid', ri.paid
  ) order by ri.id), '[]'::jsonb)
  into remaining_rows
  from public.rental_items ri
  where ri.rental_id = p_rental_id and ri.status = 'open' and ri.quantity > 0;

  is_closed := jsonb_array_length(remaining_rows) = 0;
  update public.rentals
  set status = case when is_closed then 'closed' else 'active' end,
      closed_at = case when is_closed then p_returned_at else null end
  where id = p_rental_id;

  select coalesce(sum((entry->>'quantity')::integer), 0),
         coalesce(sum((entry->>'frozenAmount')::integer), 0)
  into returned_quantity_total, returned_amount_total
  from jsonb_array_elements(returned_rows) entry;

  event_id := 'event_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
  insert into public.rental_events (
    id, rental_id, event_type, quantity, amount, details, actor, created_at
  ) values (
    event_id, p_rental_id, 'return', returned_quantity_total, returned_amount_total,
    jsonb_build_object('items', returned_rows), 'Admin', p_returned_at
  );

  return jsonb_build_object(
    'rentalId', p_rental_id,
    'returnedAt', p_returned_at,
    'returnedRows', returned_rows,
    'remainingRows', remaining_rows,
    'wasClosed', is_closed,
    'eventId', event_id
  );
end;
$$;

grant execute on function public.register_rental_return(text, jsonb, timestamptz)
  to anon, authenticated;

commit;
